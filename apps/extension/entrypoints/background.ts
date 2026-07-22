import { onMessage, sendMessage } from '../src/messaging';
import type { ContentCommand, ContentCommandResult, ExtensionErrorCode } from '@ui-agent/contracts';
import { pageInjectionIssue } from '../src/url-policy';
import { EditorTabRegistry } from '../src/editor-tab-registry';

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
      const tabId = editorTabs.resolve(editorClientId);
      if (tabId === undefined) throw new BrowserCommandError('EDITOR_NOT_READY', '插件正在连接当前页面，请稍后重试。');
      const [tab, current] = await Promise.all([browser.tabs.get(tabId), activeTab()]);
      if (current.id !== tabId) {
        throw new BrowserCommandError('TAB_CHANGED', '插件仍绑定在打开它时的页面。请切回原页面，或在当前页面重新点击插件图标。');
      }
      if (command.type === 'exportScreenshot') return await exportScreenshot(tab);
      return await sendToContent(tab, command);
    } catch (error) {
      if (error instanceof BrowserCommandError) return failure(error.code, error.message);
      return failure('BROWSER_COMMAND_FAILED', error instanceof Error ? error.message : '浏览器命令执行失败');
    }
  });
});
