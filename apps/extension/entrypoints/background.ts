import { onMessage, sendMessage } from '../src/messaging';
import type { ContentCommand, ContentCommandResult, ExtensionErrorCode } from '@ui-agent/contracts';
import { pageInjectionIssue } from '../src/url-policy';
import { EditorTabRegistry } from '../src/editor-tab-registry';
import { getAgentServiceUrl } from '../src/agent-service-config';
import { isWorkspacePreviewUrl } from '../src/agent-service-url';

class BrowserCommandError extends Error {
  constructor(readonly code: ExtensionErrorCode, message: string) {
    super(message);
  }
}

function failure(code: ExtensionErrorCode, error: string): ContentCommandResult {
  return { ok: false, code, error };
}

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new BrowserCommandError('NO_ACTIVE_TAB', '当前没有可用的活动页面');
  return tab;
}

async function waitForWorkspacePreviewTab(tabId: number, serviceUrl: string, timeoutMs = 3000): Promise<Browser.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  let tab = await browser.tabs.get(tabId);
  while (![tab.url, tab.pendingUrl].some(url => isWorkspacePreviewUrl(url, serviceUrl)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    tab = await browser.tabs.get(tabId);
  }
  return tab;
}

async function sendToContent(tab: Browser.tabs.Tab, command: ContentCommand): Promise<ContentCommandResult> {
  if (!tab.id) throw new BrowserCommandError('TAB_UNAVAILABLE', '当前标签页不可用');
  try {
    return await sendMessage('contentCommand', command, tab.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Receiving end does not exist|Could not establish connection/i.test(message)) throw error;
    const injectionIssue = pageInjectionIssue(tab.url);
    if (injectionIssue) throw new BrowserCommandError(injectionIssue.code, injectionIssue.message);
    try {
      await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/content-scripts/content.js'] });
    } catch (injectionFailure) {
      const injectionMessage = injectionFailure instanceof Error ? injectionFailure.message : String(injectionFailure);
      if (/Cannot access|permission|activeTab|extensions gallery|Chrome Web Store/i.test(injectionMessage)) {
        throw new BrowserCommandError('ACCESS_REQUIRED', '当前页面尚未获得临时访问权限。请在该页面点击一次 Chrome 工具栏中的插件图标，再点击“重新选择页面元素”。');
      }
      throw new BrowserCommandError('CONTENT_UNAVAILABLE', injectionMessage);
    }
    return await sendMessage('contentCommand', command, tab.id);
  }
}

async function exportScreenshot(tab: Browser.tabs.Tab): Promise<ContentCommandResult> {
  await sendToContent(tab, { type: 'prepareScreenshot' });
  try {
    await new Promise(resolve => setTimeout(resolve, 80));
    let dataUrl: string;
    try {
      dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/activeTab|<all_urls>/i.test(message)) {
        throw new BrowserCommandError('SCREENSHOT_PERMISSION_REQUIRED', '当前页面的截图授权已失效。请先点击一次 Chrome 工具栏中的插件图标，再重新导出；页面跳转后需要重新授权。');
      }
      throw new BrowserCommandError('SCREENSHOT_FAILED', message);
    }
    const title = (tab.title ?? 'ui-demo').replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
    await browser.downloads.download({ url: dataUrl, filename: `${title}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, saveAs: true });
    return { ok: true };
  } finally {
    await sendToContent(tab, { type: 'finishScreenshot' }).catch(() => undefined);
  }
}

export default defineBackground(() => {
  const editorTabs = new EditorTabRegistry();

  // Chrome 没有可靠的 sidePanel.onClosed。每个 Side Panel 使用唯一 clientId
  // 建立长连接，同时固定它创建时对应的标签页，避免后续命令误发到其他活动标签。
  browser.runtime.onConnect.addListener(port => {
    const match = /^ui-agent-editor:(.+)$/.exec(port.name);
    if (!match) return;
    const editorClientId = match[1]!;
    let tabId: number | undefined;
    let disconnected = false;

    const deactivateIfLastPort = () => {
      const released = editorTabs.unbind(editorClientId);
      if (released?.lastEditorForTab) {
        void sendMessage('contentCommand', { type: 'deactivateEditor' }, released.tabId).catch(() => undefined);
      }
    };

    port.onDisconnect.addListener(() => {
      disconnected = true;
      deactivateIfLastPort();
    });

    void activeTab().then(tab => {
      if (!tab.id) return;
      tabId = tab.id;
      if (disconnected) {
        editorTabs.bind(editorClientId, tabId);
        deactivateIfLastPort();
        return;
      }
      editorTabs.bind(editorClientId, tabId);
    }).catch(() => undefined);
  });

  browser.tabs.onRemoved.addListener(tabId => {
    editorTabs.removeTab(tabId);
  });

  browser.action.onClicked.addListener(tab => {
    if (tab.id) browser.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
  });

  onMessage('browserCommand', async message => {
    try {
      const { editorClientId, command } = message.data;
      if (command.type === 'bindEditorTab') {
        const serviceUrl = await getAgentServiceUrl();
        const trustedPreviewUrl = isWorkspacePreviewUrl(command.previewUrl, serviceUrl);
        const tab = trustedPreviewUrl
          ? await browser.tabs.get(command.tabId)
          : await waitForWorkspacePreviewTab(command.tabId, serviceUrl);
        if (!trustedPreviewUrl && ![tab.url, tab.pendingUrl].some(url => isWorkspacePreviewUrl(url, serviceUrl))) {
          throw new BrowserCommandError(
            'INVALID_PAGE_URL',
            `只能将编辑会话绑定到当前 Agent Service 的静态源码副本。当前地址：${tab.url ?? '未知'}；待加载地址：${tab.pendingUrl ?? '无'}`
          );
        }
        const previousTabId = editorTabs.resolve(editorClientId);
        editorTabs.bind(editorClientId, command.tabId);
        if (previousTabId !== undefined && previousTabId !== command.tabId) {
          void sendMessage('contentCommand', { type: 'deactivateEditor' }, previousTabId).catch(() => undefined);
        }
        return { ok: true };
      }
      let tabId = await editorTabs.waitFor(editorClientId);
      if (tabId === undefined) {
        // 扩展重载可能使旧 Port 的绑定事件丢失。消息只能来自扩展页面，
        // 因此可安全地将这个新 clientId 恢复到用户当前活动标签页。
        const current = await activeTab();
        tabId = current.id!;
        editorTabs.bind(editorClientId, tabId);
      }
      const [tab, current] = await Promise.all([browser.tabs.get(tabId), activeTab()]);
      if (current.id !== tabId) {
        throw new BrowserCommandError('TAB_CHANGED', '插件仍绑定在打开它时的页面。请切回原页面，或在当前页面重新点击插件图标。');
      }
      if (command.type === 'reloadPreview') {
        await browser.tabs.reload(tabId);
        return { ok: true };
      }
      if (command.type === 'exportScreenshot') return await exportScreenshot(tab);
      return await sendToContent(tab, command);
    } catch (error) {
      if (error instanceof BrowserCommandError) return failure(error.code, error.message);
      return failure('BROWSER_COMMAND_FAILED', error instanceof Error ? error.message : '浏览器命令执行失败');
    }
  });
});
