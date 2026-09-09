import { onMessage, sendMessage } from '../src/messaging';
import {
  sourceWorkspaceCreatedSchema,
  renderJobLeaseSchema,
  renderArtifactSchema,
  type RenderJobLease,
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

function candidatePreviewIdentity(tabUrl: string | undefined, serviceUrl: string) {
  if (!tabUrl || !isWorkspacePreviewUrl(tabUrl, serviceUrl)) return undefined;
  try {
    const url = new URL(tabUrl);
    const match = /^\/workspaces\/([0-9a-f-]{36})\/candidates\/([0-9a-f-]{36})\/versions\/(\d+)\/preview$/i.exec(url.pathname);
    return match ? { workspaceId: match[1]!, candidateId: match[2]!, candidateVersion: Number(match[3]) } : undefined;
  } catch {
    return undefined;
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

type RenderState = NonNullable<Extract<ContentCommandResult, { ok: true }>['renderState']>;
type RenderEvidence = { dataUrl: string; capture: { viewport: RenderState['viewport']; scroll: RenderState['scroll']; pixelWidth: number; pixelHeight: number; crop: { x: number; y: number; width: number; height: number } } };

function sameRenderState(left: RenderState | undefined, right: RenderState | undefined): boolean {
  return Boolean(left && right && left.viewport.width === right.viewport.width && left.viewport.height === right.viewport.height
    && left.viewport.devicePixelRatio === right.viewport.devicePixelRatio && left.scroll.x === right.scroll.x && left.scroll.y === right.scroll.y);
}

function pngDimensions(dataUrl: string): { width: number; height: number } | undefined {
  try {
    const binary = atob(dataUrl.slice('data:image/png;base64,'.length, 'data:image/png;base64,'.length + 32));
    if (binary.length < 24 || binary.slice(1, 4) !== 'PNG') return undefined;
    const view = new DataView(Uint8Array.from(binary, value => value.charCodeAt(0)).buffer);
    const width = view.getUint32(16); const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  } catch { return undefined; }
}

async function captureRenderEvidence(tab: Browser.tabs.Tab, document: Extract<ContentCommand, { type: 'observeWorkspacePreview' }>['document'], observedState: RenderState): Promise<RenderEvidence | undefined> {
  if (!tab.id) return undefined;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  // captureVisibleTab cannot safely capture a background tab. Waiting for a
  // later poll is preferable to silently accepting a screenshot of another page.
  if (active?.id !== tab.id) return undefined;
  const before = await sendToContent(tab, { type: 'readWorkspacePreviewState', document });
  if (!before.ok || !sameRenderState(observedState, before.renderState)) return undefined;
  await sendToContent(tab, { type: 'prepareScreenshot' });
  try {
    const current = await browser.tabs.query({ active: true, currentWindow: true });
    if (current[0]?.id !== tab.id) return undefined;
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const [activeAfterCapture] = await browser.tabs.query({ active: true, currentWindow: true });
    if (activeAfterCapture?.id !== tab.id) return undefined;
    const after = await sendToContent(tab, { type: 'readWorkspacePreviewState', document });
    const pixels = pngDimensions(dataUrl);
    return after.ok && pixels && sameRenderState(observedState, after.renderState)
      ? { dataUrl, capture: { ...observedState, pixelWidth: pixels.width, pixelHeight: pixels.height, crop: { x: 0, y: 0, width: observedState.viewport.width, height: observedState.viewport.height } } }
      : undefined;
  } finally {
    await sendToContent(tab, { type: 'finishScreenshot' }).catch(() => undefined);
  }
}

async function createWorkspaceFromViewport(tab: Browser.tabs.Tab, restoreOriginalViewport: boolean): Promise<SourceWorkspaceInfo> {
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
      type: restoreOriginalViewport ? 'capturePageSnapshotAfterViewportReflow' : 'capturePageSnapshot',
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
    await browser.tabs.update(tab.id, { url: created.previewUrl, active: true });
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
  const renderPollers = new Map<number, ReturnType<typeof setInterval>>();
  const renderPollsInFlight = new Set<number>();
  const renderPollGenerations = new Map<number, number>();
  let nextRenderPollGeneration = 0;

  const stopRenderPolling = (tabId: number) => {
    const timer = renderPollers.get(tabId);
    if (timer) clearInterval(timer);
    renderPollers.delete(tabId);
    renderPollGenerations.delete(tabId);
  };
  const reportRenderFailure = async (serviceUrl: string, job: RenderJobLease, code: string, message: string) => {
    await agentServiceFetch(`${serviceUrl}/v1/workspaces/${job.workspaceId}/render-jobs/${job.jobId}/failure`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: job.workspaceId, baseRevision: job.baseRevision, candidateId: job.candidateId,
        candidateVersion: job.candidateVersion, contentHash: job.contentHash, renderMode: job.renderMode,
        leaseToken: job.leaseToken, code, message: message.slice(0, 1_000)
      })
    }).catch(() => undefined);
  };
  const pollRenderJob = async (tabId: number) => {
    if (renderPollsInFlight.has(tabId)) return;
    renderPollsInFlight.add(tabId);
    const generation = renderPollGenerations.get(tabId);
    const isCurrent = () => renderPollGenerations.get(tabId) === generation;
    let claimedJob: RenderJobLease | undefined;
    try {
    const serviceUrl = await getAgentServiceUrl();
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    const identity = candidatePreviewIdentity(tab?.url, serviceUrl);
    if (!tab || !identity) {
      stopRenderPolling(tabId);
      return;
    }
    const response = await agentServiceFetch(
      `${serviceUrl}/v1/workspaces/${identity.workspaceId}/render-jobs/next?candidateId=${encodeURIComponent(identity.candidateId)}&candidateVersion=${identity.candidateVersion}`
    );
    if (response.status === 204 || !response.ok) return;
    const job = renderJobLeaseSchema.parse(await response.json());
    claimedJob = job;
    if (job.candidateId !== identity.candidateId || job.candidateVersion !== identity.candidateVersion) return;
    const latestTab = await browser.tabs.get(tabId).catch(() => undefined);
    const latestIdentity = candidatePreviewIdentity(latestTab?.url, serviceUrl);
    if (!latestTab || !latestIdentity || latestIdentity.workspaceId !== job.workspaceId
      || latestIdentity.candidateId !== job.candidateId || latestIdentity.candidateVersion !== job.candidateVersion) return;
    const document = {
      workspaceId: job.workspaceId, baseRevision: job.baseRevision, candidateId: job.candidateId,
      candidateVersion: job.candidateVersion, contentHash: job.contentHash, renderMode: job.renderMode
    };
    const observation = await sendToContent(latestTab, {
      type: 'observeWorkspacePreview',
      sourceIds: job.sourceIds,
      document,
      sampleId: crypto.randomUUID()
    });
    if (!observation.ok || !observation.observation) {
      await reportRenderFailure(serviceUrl, job, 'OBSERVATION_FAILED', observation.ok ? '页面未返回观察结果' : observation.error);
      return;
    }
    if (!isCurrent()) return;
    let screenshotArtifactId: string | undefined;
    if (job.screenshotRequired) {
      let evidence: RenderEvidence | undefined;
      try {
        evidence = await captureRenderEvidence(latestTab, document, observation.observation);
      } catch (error) {
        await reportRenderFailure(serviceUrl, job, 'SCREENSHOT_FAILED', error instanceof Error ? error.message : '截图失败');
        return;
      }
      if (!evidence) {
        // This is a recoverable condition: lease expiry returns the job to the
        // queue so it can run after the user returns to the candidate page.
        console.info('[ui-agent] Render evidence waiting for the active candidate page or stable viewport');
        return;
      }
      if (!isCurrent()) return;
      const artifactResponse = await agentServiceFetch(`${serviceUrl}/v1/workspaces/${job.workspaceId}/render-artifacts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: job.workspaceId, baseRevision: job.baseRevision, candidateId: job.candidateId,
          candidateVersion: job.candidateVersion, contentHash: job.contentHash, renderMode: job.renderMode,
          jobId: job.jobId, leaseToken: job.leaseToken, sampleId: observation.observation.sampleId,
          capture: evidence.capture, dataUrl: evidence.dataUrl
        })
      });
      if (!artifactResponse.ok) {
        await reportRenderFailure(serviceUrl, job, 'ARTIFACT_UPLOAD_FAILED', `截图上传失败（HTTP ${artifactResponse.status}）`);
        return;
      }
      screenshotArtifactId = renderArtifactSchema.parse(await artifactResponse.json()).artifactId;
    }
    if (!isCurrent()) return;
    const result = await agentServiceFetch(`${serviceUrl}/v1/workspaces/${identity.workspaceId}/render-jobs/${job.jobId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: job.workspaceId,
        baseRevision: job.baseRevision,
        candidateId: job.candidateId,
        candidateVersion: job.candidateVersion,
        contentHash: job.contentHash,
        renderMode: job.renderMode,
        leaseToken: job.leaseToken,
        observation: observation.observation,
        ...(screenshotArtifactId ? { screenshotArtifactId } : {})
      })
    });
    if (!result.ok) await reportRenderFailure(serviceUrl, job, 'RESULT_REJECTED', `渲染结果被服务拒绝（HTTP ${result.status}）`);
    } catch (error) {
      console.error('[ui-agent] Render polling failed', error);
      if (claimedJob) {
        const serviceUrl = await getAgentServiceUrl().catch(() => undefined);
        if (serviceUrl) await reportRenderFailure(serviceUrl, claimedJob, 'RENDER_BRIDGE_FAILED', error instanceof Error ? error.message : '渲染桥异常');
      }
    } finally {
      renderPollsInFlight.delete(tabId);
    }
  };
  const startRenderPolling = (tabId: number) => {
    if (renderPollers.has(tabId)) return;
    renderPollGenerations.set(tabId, ++nextRenderPollGeneration);
    const run = () => { void pollRenderJob(tabId).catch(() => undefined); };
    renderPollers.set(tabId, setInterval(run, 1_250));
    run();
  };

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
        stopRenderPolling(released.tabId);
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
    stopRenderPolling(tabId);
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
              stopRenderPolling(released.tabId);
              void sendMessage('contentCommand', { type: 'deactivateEditor' }, released.tabId).catch(() => undefined);
            }
            startRenderPolling(command.tabId);
            return { ok: true };
          }
          throw new BrowserCommandError(
            'TAB_CHANGED',
            '当前 Side Panel 实例属于另一个标签页。只有切换到同一静态副本时才能自动恢复；其他页面请点击插件图标重新打开。'
          );
        }
        if (panelTabId === undefined) editorTabs.bind(editorClientId, command.tabId);
        startRenderPolling(command.tabId);
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
      if (command.type === 'createWorkspaceFromFullViewport') {
        return { ok: true, workspace: await createWorkspaceFromViewport(tab, true) };
      }
      if (command.type === 'createWorkspaceFromVisibleViewport') {
        return { ok: true, workspace: await createWorkspaceFromViewport(tab, false) };
      }
      if (command.type === 'exportScreenshot') return await exportScreenshot(tab);
      return await sendToContent(tab, command);
    } catch (error) {
      if (error instanceof BrowserCommandError) return failure(error.code, error.message);
      return failure('BROWSER_COMMAND_FAILED', error instanceof Error ? error.message : '浏览器命令执行失败');
    }
  });
});
