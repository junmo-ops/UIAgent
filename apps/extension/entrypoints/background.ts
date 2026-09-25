import { onMessage, sendMessage } from '../src/messaging';
import {
  sourceWorkspaceCreatedSchema,
  type AuthorStyleResource,
  type SourceWorkspaceInfo,
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
import { sanitizeAuthorCssText } from '../src/content/author-style-capture';

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

function sameWorkspacePreview(tabUrl: string | undefined, previewUrl: string): boolean {
  if (!tabUrl) return false;
  try {
    const tab = new URL(tabUrl);
    const preview = new URL(previewUrl);
    return tab.origin === preview.origin && tab.pathname === preview.pathname;
  } catch {
    return false;
  }
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

async function hydrateAuthorStyles(tab: Browser.tabs.Tab, snapshot: NonNullable<Extract<ContentCommandResult, { ok: true }>['snapshot']>) {
  // CSSOM-readable sheets are already in authorStyles. Only retry stylesheet
  // URLs explicitly reported as unreadable, otherwise B changes cascade order
  // by appending duplicate rules.
  const sources = snapshot.authorStyles?.unreadableSources ?? [];
  if (!sources.length) return snapshot;
  const chunks: string[] = [];
  const missing = (snapshot.authorStyles?.missing ?? []).filter(source => !sources.includes(source));
  const unreadableSources: string[] = [];
  const resources: AuthorStyleResource[] = [];
  const sheets = [...(snapshot.authorStyles?.sheets ?? [])];
  for (const source of sources) {
    try {
      if (!tab.id) throw new Error('标签页不可用');
      const [execution] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (url: string) => {
          const response = await fetch(url, { credentials: 'same-origin' });
          return response.ok ? await response.text() : `__UI_AGENT_HTTP_ERROR__${response.status}`;
        },
        args: [source]
      });
      const text = execution?.result ?? '';
      if (text.startsWith('__UI_AGENT_HTTP_ERROR__')) throw new Error(text.replace('__UI_AGENT_HTTP_ERROR__', 'HTTP '));
      if (!text) throw new Error('空响应');
      const sanitized = sanitizeAuthorCssText(text.slice(0, 10_000_000), source);
      if (sanitized.cssText) chunks.push(`/* source: ${source} */\n${sanitized.cssText}`);
      const matched = sheets.some(sheet => sheet.sourceUrl === source);
      if (matched) {
        for (let index = 0; index < sheets.length; index += 1) {
          const existing = sheets[index]!;
          if (existing.sourceUrl === source) {
            sheets[index] = {
              ...existing,
              cssText: sanitized.cssText,
              renderOnly: false
            };
          }
        }
      } else {
        sheets.push({ sourceUrl: source, sourceKind: 'external', cssText: sanitized.cssText, renderOnly: false });
      }
      resources.push(...sanitized.resources);
      if (sanitized.filteredRules) missing.push(`${source}（过滤 ${sanitized.filteredRules} 条不安全规则）`);
    } catch (error) {
      missing.push(`${source}（${error instanceof Error ? error.message : '读取失败'}）`);
      unreadableSources.push(source);
    }
  }
  const orderedCss = sheets
    .filter(sheet => !sheet.renderOnly && sheet.cssText)
    .map(sheet => `/* source: ${sheet.sourceUrl} */\n${sheet.cssText}`)
    .join('\n\n');
  if (!orderedCss && !snapshot.authorStyles?.cssText) return snapshot;
  return {
    ...snapshot,
    authorStyles: {
      cssText: orderedCss || [...(snapshot.authorStyles?.cssText ? [snapshot.authorStyles.cssText] : []), ...chunks].join('\n\n'),
      readableSheets: (snapshot.authorStyles?.readableSheets ?? 0) + chunks.length,
      unreadableSheets: missing.length,
      missing,
      sources: [...new Set([...(snapshot.authorStyles?.sources ?? []), ...sources])],
      unreadableSources: [...new Set(unreadableSources)],
      sheets: sheets.length ? sheets : undefined,
      resources: [...(snapshot.authorStyles?.resources ?? []), ...resources]
    }
  };
}

async function createWorkspaceFromViewport(tab: Browser.tabs.Tab): Promise<SourceWorkspaceInfo> {
  if (!tab.id) throw new BrowserCommandError('TAB_UNAVAILABLE', '当前标签页不可用');
  try {
    // The preview replaces the source in this same tab.  Capturing the current
    // viewport keeps the Side Panel alive and avoids forcing the user to open
    // the extension again in a newly created preview tab.
    const serviceUrl = await getAgentServiceUrl();
    const capabilitiesResponse = await agentServiceFetch(`${serviceUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(15_000) });
    if (!capabilitiesResponse.ok) throw new Error('无法读取副本采集配置');
    const capabilities = await capabilitiesResponse.json() as { replicaAEnabled?: boolean };
    const captured = await sendToContent(tab, {
      type: 'capturePageSnapshot',
      includeFrozenStyles: capabilities.replicaAEnabled === true
    });
    if (!captured.ok) throw new BrowserCommandError(captured.code, captured.error);
    if (!captured.snapshot) throw new BrowserCommandError('PAGE_OPERATION_FAILED', '页面没有返回静态源码副本');
    const hydratedSnapshot = await hydrateAuthorStyles(tab, captured.snapshot);

    const response = await agentServiceFetch(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hydratedSnapshot)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new BrowserCommandError('PAGE_OPERATION_FAILED', `静态源码工作区服务返回 ${response.status}${detail ? `：${detail}` : ''}`);
    }
    const created = sourceWorkspaceCreatedSchema.parse(await response.json());
    await sourceWorkspaceSessionItem.setValue({
      workspace: {
        ...created,
        sourceUrl: hydratedSnapshot.sourceUrl,
        revision: 0,
        canUndo: false,
        canRedo: false
      },
      chat: [],
      editSessionId: crypto.randomUUID(),
      sourceTabId: tab.id
    });
    await browser.tabs.update(tab.id, { url: created.previewUrl });
    return {
      ...created,
      sourceUrl: hydratedSnapshot.sourceUrl,
      revision: 0,
      canUndo: false,
      canRedo: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '创建静态副本失败';
    console.error('[ui-agent] Failed to create workspace snapshot', error);
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
        const tab = await waitForWorkspacePreviewTab(command.tabId, serviceUrl);
        if (!trustedPreviewUrl || ![tab.url, tab.pendingUrl].some(url => sameWorkspacePreview(url, command.previewUrl))) {
          throw new BrowserCommandError(
            'INVALID_PAGE_URL',
            `只能将编辑会话绑定到当前 Agent Service 创建的指定静态副本。当前地址：${tab.url ?? '未知'}；待加载地址：${tab.pendingUrl ?? '无'}`
          );
        }
        const panelTabId = await editorTabs.waitFor(editorClientId);
        if (panelTabId !== undefined && panelTabId !== command.tabId) {
          if (trustedPreviewUrl && sameWorkspacePreview(tab.url, command.previewUrl)) {
            const released = editorTabs.rebind(editorClientId, command.tabId);
            if (released?.lastEditorForTab) {
              void sendMessage('contentCommand', { type: 'deactivateEditor' }, released.tabId).catch(() => undefined);
            }
            return { ok: true };
          }
          throw new BrowserCommandError(
            'TAB_CHANGED',
            '当前 Side Panel 实例属于另一个标签页。只有切换到同一静态副本时才能自动恢复；其他页面请点击插件图标重新打开。'
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
      if (command.type === 'reloadPreview') {
        // Reloading a known static preview does not inspect or modify the active
        // browser page. Keep it independent from the active-tab safety boundary
        // so a completed source turn is visible when the user returns to it.
        const tab = await browser.tabs.get(tabId);
        const serviceUrl = await getAgentServiceUrl();
        if (!isWorkspacePreviewUrl(tab.url, serviceUrl)) {
          throw new BrowserCommandError('INVALID_PAGE_URL', '只能后台刷新当前 Agent Service 创建的静态源码副本。');
        }
        await browser.tabs.reload(tabId);
        return { ok: true };
      }
      const [tab, current] = await Promise.all([browser.tabs.get(tabId), activeTab()]);
      if (current.id !== tabId) {
        throw new BrowserCommandError('TAB_CHANGED', '插件仍绑定在打开它时的页面。请切回原页面，或在当前页面重新点击插件图标。');
      }
      if (command.type === 'createWorkspaceFromVisibleViewport') {
        return { ok: true, workspace: await createWorkspaceFromViewport(tab), tabId: tab.id };
      }
      return await sendToContent(tab, command);
    } catch (error) {
      if (error instanceof BrowserCommandError) return failure(error.code, error.message);
      return failure('BROWSER_COMMAND_FAILED', error instanceof Error ? error.message : '浏览器命令执行失败');
    }
  });
});
