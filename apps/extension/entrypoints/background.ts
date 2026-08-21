import { onMessage, sendMessage } from '../src/messaging';
import {
  sourceWorkspaceCreatedSchema,
  type ContentCommand,
  type ContentCommandResult,
  type ExtensionErrorCode
} from '@ui-agent/contracts';
import { pageInjectionIssue } from '../src/session/url-policy';
import { EditorTabRegistry } from '../src/session/editor-tab-registry';
import {
  disableGlobalSidePanel,
  openTabScopedSidePanel
} from '../src/session/tab-scoped-side-panel';
import { getAgentServiceUrl } from '../src/service/agent-service-config';
import { agentServiceFetch } from '../src/service/agent-service-client';
import { isWorkspacePreviewUrl } from '../src/service/agent-service-url';
import { sourceWorkspaceSessionItem } from '../src/session/source-workspace-session';

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

async function createWorkspaceFromViewport(tab: Browser.tabs.Tab, restoreOriginalViewport: boolean): Promise<void> {
  if (!tab.id) throw new BrowserCommandError('TAB_UNAVAILABLE', '当前标签页不可用');
  // Create the destination before disabling the Side Panel. The source panel
  // is expected to unload, so the background owns the rest of the workflow.
  const loadingTab = await browser.tabs.create({
    url: browser.runtime.getURL('/workspace-loading.html'),
    active: false
  });
  if (!loadingTab.id) throw new BrowserCommandError('TAB_UNAVAILABLE', '静态副本标签页创建失败');
  try {
    // The Side Panel changes the page viewport. Do not try to compensate by
    // adding pixels back: responsive CSS has already selected another layout.
    // When requested, restore the natural viewport before content capture.
    if (restoreOriginalViewport) {
      await browser.sidePanel.setOptions({ tabId: tab.id, enabled: false });
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    const captured = await sendToContent(tab, {
      type: restoreOriginalViewport ? 'capturePageSnapshotAfterViewportReflow' : 'capturePageSnapshot'
    });
    if (!captured.ok) throw new BrowserCommandError(captured.code, captured.error);
    if (!captured.snapshot) throw new BrowserCommandError('PAGE_OPERATION_FAILED', '页面没有返回静态源码副本');

    const serviceUrl = await getAgentServiceUrl();
    const response = await agentServiceFetch(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(captured.snapshot)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new BrowserCommandError('PAGE_OPERATION_FAILED', `静态源码工作区服务返回 ${response.status}${detail ? `：${detail}` : ''}`);
    }
    const created = sourceWorkspaceCreatedSchema.parse(await response.json());
    await sourceWorkspaceSessionItem.setValue({
      workspace: {
        ...created,
        sourceUrl: captured.snapshot.sourceUrl,
        revision: 0,
        canUndo: false,
        canRedo: false
      },
      chat: [],
      editSessionId: crypto.randomUUID(),
      sourceTabId: tab.id
    });
    await browser.tabs.update(loadingTab.id, { url: created.previewUrl, active: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '创建静态副本失败';
    console.error('[ui-agent] Failed to create workspace snapshot', error);
    await browser.tabs.update(loadingTab.id, {
      url: `${browser.runtime.getURL('/workspace-loading.html')}?error=${encodeURIComponent(message)}`,
      active: true
    }).catch(() => undefined);
    throw error;
  }
}

export default defineBackground(() => {
  const editorTabs = new EditorTabRegistry();

  // The manifest path is a global fallback. Disable it so Chrome hides this
  // extension's panel on every tab that has not explicitly opened its own.
  void disableGlobalSidePanel(browser.sidePanel).catch(error => {
    console.error('[ui-agent] Failed to disable the global side panel', error);
  });

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
    if (tab.id) void openTabScopedSidePanel(browser.sidePanel, tab.id).catch(error => {
      console.error(`[ui-agent] Failed to open the side panel for tab ${tab.id}`, error);
    });
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
        const panelTabId = await editorTabs.waitFor(editorClientId);
        if (panelTabId !== undefined && panelTabId !== command.tabId) {
          throw new BrowserCommandError(
            'TAB_CHANGED',
            '当前 Side Panel 实例属于另一个标签页，不能迁移到静态副本。请在静态副本标签页点击插件图标。'
          );
        }
        if (panelTabId === undefined) editorTabs.bind(editorClientId, command.tabId);
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
      if (command.type === 'createWorkspaceFromFullViewport') {
        await createWorkspaceFromViewport(tab, true);
        return { ok: true };
      }
      if (command.type === 'createWorkspaceFromVisibleViewport') {
        await createWorkspaceFromViewport(tab, false);
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
