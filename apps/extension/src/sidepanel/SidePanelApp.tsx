import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Spin, Tooltip } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import {
  type SourceTurnRequest,
  PROTOCOL_VERSION,
  assistantTurnRequestSchema,
  assistantTurnResponseSchema,
  sourceTurnRequestSchema,
  sourceTurnAcceptedSchema,
  sourceTurnProgressSchema,
  renderJobStatusSchema,
  candidateGeometryValidationResultSchema,
  sourceWorkspaceCreatedSchema,
  sourceWorkspaceInfoSchema,
  workspaceChatEntrySchema,
  workspaceConversationResponseSchema,
  type AssistantTurnResponse,
  type ContentCommand,
  type ContentCommandResult,
  type PageSelection,
  type SourceWorkspaceInfo,
  type SourceTurnResponse,
  type SourceTurnProgress
} from '@ui-agent/contracts';
import { onMessage, sendMessage } from '../messaging';
import { DEFAULT_AGENT_SERVICE_URL, getAgentServiceUrl } from '../service/agent-service-config';
import { agentServiceFetch } from '../service/agent-service-client';
import { readAssistantEventStream } from '../service/assistant-event-stream';
import {
  fetchAvailableExtensionUpdate,
  type ExtensionUpdateInfo
} from '../service/extension-update';
import {
  sourceWorkspaceSessionItem,
  type ActiveSourceTurnSession,
  type WorkspaceChatEntry,
  type WorkspaceClarificationPrompt
} from '../session/source-workspace-session';

const MarkdownMessage = lazy(() => import('./MarkdownMessage').then(module => ({
  default: module.MarkdownMessage
})));

// Side Panel 文档关闭时 Chrome 会自动断开该 Port，Background 据此立即清理选区。
const editorClientId = crypto.randomUUID();
const editorPort = browser.runtime.connect({ name: `ui-agent-editor:${editorClientId}` });
// 保留 Port 引用，避免扩展重载或长时间空闲时被垃圾回收而提前触发 onDisconnect。
void editorPort;

type ClarificationPrompt = WorkspaceClarificationPrompt;
type ChatEntry = WorkspaceChatEntry;
type CompletedSourceTurn = Extract<SourceTurnResponse, { kind: 'completed' }>;
type ServiceStatus = 'checking' | 'connected' | 'unavailable';
interface ActiveWorkspace extends SourceWorkspaceInfo {
  tabId: number;
  sourceTabId?: number;
}
type IconName = 'sparkle' | 'target' | 'edit' | 'snapshot' | 'undo' | 'redo' | 'reset' | 'download' | 'upload' | 'arrow' | 'stop' | 'back' | 'more';

function UiIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    sparkle: <><path d="M12 2.8c.5 4.6 2.6 6.7 7.2 7.2-4.6.5-6.7 2.6-7.2 7.2-.5-4.6-2.6-6.7-7.2-7.2 4.6-.5 6.7-2.6 7.2-7.2Z" /><path d="M18.5 16.5c.2 1.8 1 2.6 2.7 2.8-1.7.2-2.5 1-2.7 2.7-.2-1.7-1-2.5-2.7-2.7 1.7-.2 2.5-1 2.7-2.8Z" /></>,
    target: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
    edit: <><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
    snapshot: <><rect x="3.5" y="5" width="14" height="14" rx="2" /><path d="M7 2.5h12.5a2 2 0 0 1 2 2V17" /><path d="m6.5 15 3.2-3.2 2.4 2.4 2-2 1.8 1.8" /></>,
    undo: <><path d="m9 7-5 5 5 5" /><path d="M5 12h8a6 6 0 0 1 6 6" /></>,
    redo: <><path d="m15 7 5 5-5 5" /><path d="M19 12h-8a6 6 0 0 0-6 6" /></>,
    reset: <><path d="M4.8 8A8 8 0 1 1 4 15" /><path d="M4 4v5h5" /></>,
    download: <><path d="M12 3v12" /><path d="m7.5 11 4.5 4.5 4.5-4.5" /><path d="M5 21h14" /></>,
    upload: <><path d="M12 21V9" /><path d="m7.5 13.5 4.5-4.5 4.5 4.5" /><path d="M5 3h14" /></>,
    arrow: <><path d="M12 19V5" /><path d="m6.5 10.5 5.5-5.5 5.5 5.5" /></>,
    stop: <rect x="7.5" y="7.5" width="9" height="9" rx="1.25" fill="currentColor" stroke="none" />,
    back: <><path d="m10 7-5 5 5 5" /><path d="M5 12h14" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

async function command(value: ContentCommand): Promise<Extract<ContentCommandResult, { ok: true }>> {
  const result = await sendMessage('browserCommand', { editorClientId, command: value });
  if (!result.ok) throw new Error(`[${result.code}] ${result.error}`);
  return result;
}

async function serviceResponseError(response: Response, fallback: string): Promise<Error> {
  try {
    const payload = await response.json() as { message?: unknown; traceId?: unknown };
    const message = typeof payload.message === 'string' ? payload.message : undefined;
    const traceId = typeof payload.traceId === 'string' ? payload.traceId : undefined;
    return new Error([
      `${fallback} ${response.status}`,
      message,
      traceId ? `traceId=${traceId}` : undefined
    ].filter(Boolean).join('：'));
  } catch {
    return new Error(`${fallback} ${response.status}`);
  }
}

async function fetchAgentService(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await agentServiceFetch(url, init);
  } catch {
    const origin = (() => { try { return new URL(url).origin; } catch { return url; } })();
    throw new Error(`无法连接 Agent Service（${origin}）。请确认服务地址可访问；跨电脑使用时不能指向 127.0.0.1。`);
  }
}

/** Accept both a committed workspace and an immutable candidate preview. */
function previewWorkspaceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const path = new URL(value).pathname;
    const match = /^\/workspaces\/([0-9a-f-]{36})(?:\/preview|\/candidates\/[0-9a-f-]{36}\/versions\/\d+\/preview)\/?$/i.exec(path);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function SidePanelApp() {
  const [instruction, setInstruction] = useState('');
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [selection, setSelection] = useState<PageSelection>();
  const [selecting, setSelecting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [serviceUrl, setServiceUrl] = useState(DEFAULT_AGENT_SERVICE_URL);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>('checking');
  const [editSessionId, setEditSessionId] = useState<string>(() => crypto.randomUUID());
  const [sourceWorkspace, setSourceWorkspace] = useState<ActiveWorkspace>();
  const [sourceProgress, setSourceProgress] = useState<SourceTurnProgress>();
  const [activeSourceTurn, setActiveSourceTurn] = useState<ActiveSourceTurnSession>();
  const [pendingClarification, setPendingClarification] = useState<ClarificationPrompt>();
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [streamingAnswerId, setStreamingAnswerId] = useState<string>();
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<ExtensionUpdateInfo>();
  const composerRef = useRef<TextAreaRef>(null);
  const repairValidationAbortRef = useRef<AbortController | undefined>(undefined);
  const resumedTurnIdsRef = useRef(new Set<string>());
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  const busy = snapshotBusy || assistantBusy || Boolean(activeSourceTurn) || Boolean(sourceWorkspace && !sessionReady);
  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => {
      if (disposed) return;
      setNotice('正在重新连接副本服务…');
      retryTimer = setTimeout(() => setInitializationAttempt(value => value + 1), 3000);
    };
    getAgentServiceUrl().then(async url => {
      setServiceUrl(url);
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const workspaceId = previewWorkspaceId(tab?.url);
      if (!workspaceId || !tab?.id || !tab.url) return;
      try {
        const [response, conversationResponse, persisted] = await Promise.all([
          fetchAgentService(`${url.replace(/\/$/, '')}/v1/workspaces/${workspaceId}`, { signal: AbortSignal.timeout(15_000) }),
          fetchAgentService(`${url.replace(/\/$/, '')}/v1/workspaces/${workspaceId}/conversation`, { signal: AbortSignal.timeout(15_000) }),
          sourceWorkspaceSessionItem.getValue(workspaceId)
        ]);
        if (response.status === 404) {
          if (!disposed) { setError('该副本不存在或当前账号无法访问'); setNotice(undefined); }
          return;
        }
        if (!response.ok || !conversationResponse.ok) throw new Error('副本服务暂不可用');
        if (disposed) return;
        const workspace = sourceWorkspaceInfoSchema.parse(await response.json());
        const restoredWorkspace = persisted?.workspace.workspaceId === workspace.workspaceId
          ? { ...workspace, selectedSourceId: persisted.workspace.selectedSourceId }
          : workspace;
        setSourceWorkspace({
          ...restoredWorkspace,
          tabId: tab.id,
          sourceTabId: persisted?.workspace.workspaceId === workspace.workspaceId
            ? persisted.sourceTabId
            : undefined
        });
        const serverConversation = conversationResponse.ok
          ? workspaceConversationResponseSchema.parse(await conversationResponse.json()).entries
          : [];
        if (serverConversation.length > 0) {
          setChat(serverConversation);
          const unresolved = [...serverConversation].reverse().find(entry => (
            entry.clarification && !entry.clarification.resolved
          ));
          setPendingClarification(unresolved?.clarification);
        } else if (persisted?.workspace.workspaceId === workspace.workspaceId) {
          // Preserve pre-migration local sessions only while the server has no history yet.
          setChat(persisted.chat);
        }
        if (persisted?.workspace.workspaceId === workspace.workspaceId) {
          setEditSessionId(persisted.editSessionId);
          setPendingClarification(persisted.pendingClarification);
          setActiveSourceTurn(persisted.activeSourceTurn);
        }
        // Keep the exact candidate URL: its identity is what enables render-job polling.
        await command({ type: 'bindEditorTab', tabId: tab.id, previewUrl: tab.url });
        if (!disposed) { setSessionReady(true); setNotice(undefined); }
      } catch { retry(); }
    }).catch(retry);
    return () => { disposed = true; clearTimeout(retryTimer); };
  }, [initializationAttempt]);
  useEffect(() => {
    if (!sourceWorkspace) return;
    const onActivated = async ({ tabId }: { tabId: number }) => {
      try {
        const tab = await browser.tabs.get(tabId);
        const workspaceId = previewWorkspaceId(tab.url);
        if (!workspaceId || workspaceId !== sourceWorkspace.workspaceId || !tab.url) return;
        await command({ type: 'bindEditorTab', tabId, previewUrl: tab.url });
        setSourceWorkspace(current => current ? { ...current, tabId } : current);
        setSelection(undefined);
        setSelecting(false);
      } catch {
        // Keep the existing binding when the active page is unavailable or not a trusted preview.
      }
    };
    browser.tabs.onActivated.addListener(onActivated);
    return () => browser.tabs.onActivated.removeListener(onActivated);
  }, [sourceWorkspace?.workspaceId, sourceWorkspace?.previewUrl]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    setServiceStatus('checking');
    fetchAgentService(`${serviceUrl}/health`, { signal: controller.signal, cache: 'no-store' })
      .then(response => setServiceStatus(response.ok ? 'connected' : 'unavailable'))
      .catch(() => setServiceStatus('unavailable'))
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [serviceUrl]);
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      try {
        const update = await fetchAvailableExtensionUpdate(serviceUrl);
        if (!disposed) setAvailableUpdate(update);
      } catch {
        // 更新检查不能影响插件核心功能，下次打开或定时检查时再重试。
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 6 * 60 * 60 * 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [serviceUrl]);
  useEffect(() => {
    if (!sourceWorkspace || !sessionReady) return;
    const { tabId: _tabId, sourceTabId: _sourceTabId, ...workspace } = sourceWorkspace;
    void sourceWorkspaceSessionItem.setValue({
      workspace,
      chat,
      editSessionId,
      sourceTabId: sourceWorkspace.sourceTabId,
      pendingClarification,
      activeSourceTurn
    });
  }, [sourceWorkspace, chat, editSessionId, pendingClarification, activeSourceTurn, sessionReady]);
  useEffect(() => {
    const heartbeat = () => { void command({ type: 'editorHeartbeat' }).catch(() => undefined); };
    const deactivate = () => { void command({ type: 'deactivateEditor' }).catch(() => undefined); };
    heartbeat();
    const timer = window.setInterval(heartbeat, 3000);
    window.addEventListener('pagehide', deactivate);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', deactivate);
    };
  }, []);
  useEffect(() => onMessage('selectionChanged', message => {
    const sourceId = message.data.selected.sourceId;
    if (sourceId) setSourceWorkspace(current => current ? { ...current, selectedSourceId: sourceId } : current);
    setSelection(message.data);
    setSelecting(false);
    setError(undefined);
  }), []);

  const persistWorkspaceChat = async (
    entry: ChatEntry,
    workspace = sourceWorkspace,
    revision = workspace?.revision
  ) => {
    if (!workspace || revision === undefined) return;
    const payload = workspaceChatEntrySchema.parse({
      ...entry,
      createdAt: new Date().toISOString(),
      revision
    });
    const response = await fetchAgentService(
      `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${workspace.workspaceId}/conversation`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    if (!response.ok) throw await serviceResponseError(response, '保存副本对话返回');
  };

  const appendChat = async (
    role: ChatEntry['role'],
    text: string,
    clarification?: ClarificationPrompt,
    revision?: number,
    entryId: string = crypto.randomUUID()
  ) => {
    const entry: ChatEntry = { id: entryId, role, text, ...(clarification && { clarification }) };
    setChat(entries => entries.some(current => current.id === entry.id) ? entries : [...entries, entry]);
    await persistWorkspaceChat(entry, sourceWorkspace, revision);
    return entry;
  };

  const startSelection = async () => {
    try { await command({ type: 'startSelection' }); setSelecting(true); }
    catch (error) { fail(error); }
  };

  const submitText = async (
    text: string,
    replyToClarificationId?: string,
    clarificationOptionId?: string
  ) => {
    if (!text || busy) return;
    const turnId = crypto.randomUUID();
    await appendChat('user', text, undefined, undefined, turnId);
    setInstruction('');
    if (replyToClarificationId) setPendingClarification(undefined);
    setAssistantBusy(true);
    try {
      const request = assistantTurnRequestSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        turnId,
        traceId: crypto.randomUUID(),
        instruction: text,
        context: {
          hasWorkspace: Boolean(sourceWorkspace),
          hasSelection: Boolean(selection),
          ...(selection && {
            selection: {
              sourceId: selection.selected.sourceId,
              tag: selection.selected.tag,
              role: selection.selected.role,
              text: selection.selected.text.slice(0, 1_000)
            }
          })
        },
        conversation: chat.slice(-11).map(entry => ({
          role: entry.role,
          text: entry.text.slice(0, 10_000)
        })),
        ...(replyToClarificationId && { replyToClarificationId }),
        ...(clarificationOptionId && { clarificationOptionId })
      });
      const response = await fetchAgentService(`${serviceUrl.replace(/\/$/, '')}/v1/assistant/turns/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      });
      if (!response.ok) throw await serviceResponseError(response, '智能助手返回');
      let outcome: AssistantTurnResponse | undefined;
      let streamedEntryId: string | undefined;
      let streamedText = '';
      await readAssistantEventStream(response, event => {
        if (event.type === 'error') throw new Error(`[${event.code}] ${event.message}`);
        if (event.type === 'result') {
          outcome = assistantTurnResponseSchema.parse(event.result);
          return;
        }
        streamedText += event.text;
        if (!streamedEntryId) {
          streamedEntryId = crypto.randomUUID();
          setStreamingAnswerId(streamedEntryId);
          setChat(entries => [...entries, {
            id: streamedEntryId!,
            role: 'assistant',
            text: streamedText
          }]);
        } else {
          const id = streamedEntryId;
          setChat(entries => entries.map(entry => entry.id === id
            ? { ...entry, text: streamedText }
            : entry));
        }
      });
      const finalOutcome = outcome as AssistantTurnResponse | undefined;
      if (!finalOutcome) throw new Error('智能助手数据流提前结束');
      if (finalOutcome.kind === 'failed') throw new Error(`[${finalOutcome.code}] ${finalOutcome.message}`);
      if (finalOutcome.kind === 'answered') {
        const finalAnswer = finalOutcome.answer;
        const id = streamedEntryId;
        const answerEntry: ChatEntry = id
          ? { id, role: 'assistant', text: finalAnswer }
          : { id: crypto.randomUUID(), role: 'assistant', text: finalAnswer };
        setChat(entries => id
          ? entries.map(entry => entry.id === id ? answerEntry : entry)
          : [...entries, answerEntry]);
        await persistWorkspaceChat(answerEntry);
        return;
      }
      if (finalOutcome.kind === 'clarification') {
        const clarification = {
          clarificationId: finalOutcome.clarificationId,
          options: finalOutcome.options,
          allowFreeText: finalOutcome.allowFreeText
        };
        setPendingClarification(clarification);
        await appendChat('assistant', finalOutcome.question, clarification);
        return;
      }
      if (!sourceWorkspace) throw new Error('需要先进入副本编辑，才能执行页面修改');
      setAssistantBusy(false);
      await runSourceTurn(
        finalOutcome.instruction,
        sourceWorkspace,
        finalOutcome.targetScope === 'selection' ? selection?.selected.sourceId : undefined,
        turnId,
        { replyToClarificationId, clarificationOptionId }
      );
    } catch (error) {
      fail(error);
    } finally {
      setAssistantBusy(false);
      setStreamingAnswerId(undefined);
    }
  };

  const submit = async () => {
    const text = instruction.trim();
    if (!text) return;
    await submitText(text, pendingClarification?.clarificationId);
  };

  const history = async (type: 'undo' | 'redo' | 'reset') => {
    if (busy) return;
    try {
      if (!sourceWorkspace) return;
      setSnapshotBusy(true);
      const response = await fetchAgentService(
        `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${sourceWorkspace.workspaceId}/${type}`,
        { method: 'POST' }
      );
      if (!response.ok) throw await serviceResponseError(response, '源码副本版本接口返回');
      const value = await response.json() as Pick<SourceWorkspaceInfo, 'revision' | 'canUndo' | 'canRedo'>;
      setSourceWorkspace(current => current ? { ...current, ...value } : current);
      const conversationResponse = await fetchAgentService(
        `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${sourceWorkspace.workspaceId}/conversation`,
        { cache: 'no-store' }
      );
      if (conversationResponse.ok) {
        const entries = workspaceConversationResponseSchema.parse(await conversationResponse.json()).entries;
        setChat(entries);
        const unresolved = [...entries].reverse().find(entry => entry.clarification && !entry.clarification.resolved);
        setPendingClarification(unresolved?.clarification);
      }
      await command({ type: 'reloadPreview' });
    } catch (error) { fail(error); }
    finally { setSnapshotBusy(false); }
  };

  const exportScreenshot = async () => { try { await command({ type: 'exportScreenshot' }); } catch (error) { fail(error); } };
  const returnToSource = async () => {
    if (!sourceWorkspace?.sourceTabId) return;
    try {
      if (sourceWorkspace.sourceTabId === sourceWorkspace.tabId) {
        await browser.tabs.update(sourceWorkspace.tabId, { url: sourceWorkspace.sourceUrl, active: true });
        await sourceWorkspaceSessionItem.setValue(null);
        setSourceWorkspace(undefined);
        setChat([]);
        setPendingClarification(undefined);
        return;
      }
      await browser.tabs.update(sourceWorkspace.sourceTabId, { active: true });
    } catch {
      fail(new Error('原页面标签页已关闭'));
    }
  };
  const openWorkspaceManager = async () => {
    await browser.tabs.create({ url: browser.runtime.getURL('/workspace-manager.html') });
  };
  const refreshFormalWorkspace = async (workspace: ActiveWorkspace): Promise<ActiveWorkspace> => {
    const response = await fetchAgentService(
      `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${workspace.workspaceId}`,
      { cache: 'no-store', signal: AbortSignal.timeout(15_000) }
    );
    if (!response.ok) throw await serviceResponseError(response, '刷新副本版本返回');
    const latest = sourceWorkspaceInfoSchema.parse(await response.json());
    const refreshed = { ...latest, tabId: workspace.tabId, sourceTabId: workspace.sourceTabId };
    setSourceWorkspace(current => current?.workspaceId === workspace.workspaceId ? refreshed : current);
    return refreshed;
  };
  const applyCompletedDirectTurn = async (
    outcome: CompletedSourceTurn,
    workspace: ActiveWorkspace,
    assistantEntryId: string
  ) => {
    const refreshed = await refreshFormalWorkspace(workspace);
    await appendChat('assistant', outcome.summary, undefined, refreshed.revision, assistantEntryId);
    // 已满足需求时服务端不会产生新 Revision，预览页也无需重载。
    if (!outcome.unchanged) await command({ type: 'reloadPreview' });
  };
  const persistActiveSourceTurn = async (workspace: ActiveWorkspace, activeTurn: ActiveSourceTurnSession) => {
    const { tabId: _tabId, sourceTabId: _sourceTabId, ...persistedWorkspace } = workspace;
    const existing = await sourceWorkspaceSessionItem.getValue(workspace.workspaceId);
    await sourceWorkspaceSessionItem.setValue({
      workspace: persistedWorkspace,
      chat: existing?.workspace.workspaceId === workspace.workspaceId ? existing.chat : chat,
      editSessionId,
      sourceTabId: workspace.sourceTabId,
      pendingClarification,
      activeSourceTurn: activeTurn
    });
  };
  const clearPersistedActiveSourceTurn = async (workspaceId: string, turnId: string) => {
    const existing = await sourceWorkspaceSessionItem.getValue(workspaceId);
    if (
      existing?.workspace.workspaceId !== workspaceId
      || existing.activeSourceTurn?.turnId !== turnId
    ) return;
    await sourceWorkspaceSessionItem.setValue({ ...existing, activeSourceTurn: undefined });
  };
  const waitForSourceTurn = async (workspaceId: string, turnId: string) => {
    const url = `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${workspaceId}/turns/${turnId}/progress`;
    while (true) {
      const response = await fetchAgentService(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (response.status === 404) return undefined;
      if (!response.ok) throw await serviceResponseError(response, '查询修改任务返回');
      const progress = sourceTurnProgressSchema.parse(await response.json());
      setSourceProgress(progress);
      if (progress.status !== 'running' && progress.status !== 'cancelling') return progress;
      await new Promise<void>(resolve => window.setTimeout(resolve, 650));
    }
  };
  const runSourceTurn = async (
    text: string,
    workspace: ActiveWorkspace,
    sourceId?: string,
    turnId = crypto.randomUUID(),
    clarificationReply: Pick<SourceTurnRequest, 'replyToClarificationId' | 'clarificationOptionId'> = {}
  ) => {
    setSnapshotBusy(true);
    let settled = false;
    let requestMayHaveStarted = false;
    setRecoveryAttempt(0);
    const activeTurn: ActiveSourceTurnSession = {
      turnId,
      instruction: text,
      baseRevision: workspace.revision,
      assistantEntryId: crypto.randomUUID(),
      startedAt: new Date().toISOString()
    };
    resumedTurnIdsRef.current.add(turnId);
    setActiveSourceTurn(activeTurn);
    try {
      await persistActiveSourceTurn(workspace, activeTurn);
      const request = sourceTurnRequestSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        editSessionId,
        turnId,
        traceId: crypto.randomUUID(),
        instruction: text,
        sourceId,
        ...clarificationReply
      });
      setSourceProgress({
        workspaceId: workspace.workspaceId,
        turnId: request.turnId,
        status: 'running',
        phase: 'analyzing',
        message: '正在理解修改目标…',
        modelCalls: 0,
        toolCalls: 0,
        updatedAt: new Date().toISOString(),
        activities: []
      });
      requestMayHaveStarted = true;
      const response = await fetchAgentService(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${workspace.workspaceId}/turns`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      });
      if (!response.ok) {
        // A server error may occur after acceptance; only explicit client rejection is final.
        settled = response.status >= 400 && response.status < 500 && response.status !== 408;
        throw await serviceResponseError(response, '源码 Agent 返回');
      }
      sourceTurnAcceptedSchema.parse(await response.json());
      const progress = await waitForSourceTurn(workspace.workspaceId, turnId);
      if (!progress) throw new Error('任务状态已丢失，正在重新核对正式副本');
      const outcome = progress.result;
      if (!outcome) throw new Error('源码任务已结束，但未返回最终结果');
      if (outcome.kind === 'cancelled') {
        await appendChat('assistant', outcome.message, undefined, workspace.revision, activeTurn.assistantEntryId);
        settled = true;
        return;
      }
      if (outcome.kind === 'clarification') {
        const clarification = {
          clarificationId: outcome.clarificationId ?? crypto.randomUUID(),
          options: outcome.options,
          allowFreeText: outcome.allowFreeText
        };
        setPendingClarification(clarification);
        await appendChat('assistant', outcome.question, clarification, workspace.revision, activeTurn.assistantEntryId);
        settled = true;
        return;
      }
      if (outcome.kind === 'failed') {
        await appendChat('assistant', `本轮修改未完成：${outcome.message}`, undefined, workspace.revision, activeTurn.assistantEntryId);
        settled = true;
        return;
      }
      if (outcome.kind === 'draft') {
        if (!outcome.previewUrl) throw new Error('候选草稿已生成，但没有可打开的预览地址');
        const tab = await browser.tabs.update(workspace.tabId, { url: outcome.previewUrl, active: true });
        const candidateTabId = tab?.id;
        if (candidateTabId === undefined) throw new Error('候选草稿标签页不可用');
        await command({ type: 'bindEditorTab', tabId: candidateTabId, previewUrl: outcome.previewUrl });
        setSourceWorkspace(current => current ? { ...current, tabId: candidateTabId } : current);
        // A retained candidate is useful audit/repair input, but it must not
        // become the editing baseline after a failed validation.  The next
        // source turn is always created from the formal workspace revision.
        const returnToFormalPreview = async () => {
          const workspaceResponse = await fetchAgentService(
            `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${workspace.workspaceId}`,
            { cache: 'no-store' }
          );
          if (!workspaceResponse.ok) throw await serviceResponseError(workspaceResponse, '返回正式副本');
          const published = sourceWorkspaceInfoSchema.parse(await workspaceResponse.json());
          const formalTab = await browser.tabs.update(candidateTabId, { url: published.previewUrl, active: true });
          const formalTabId = formalTab?.id;
          if (formalTabId === undefined) throw new Error('正式副本标签页不可用');
          await command({ type: 'bindEditorTab', tabId: formalTabId, previewUrl: published.previewUrl });
          setSourceWorkspace(current => current ? { ...published, tabId: formalTabId } : current);
        };
        await appendChat('assistant', `${outcome.summary}。正在等待真实渲染与验证。`, undefined, workspace.revision);
        setNotice('候选草稿已生成，正在检查渲染结果');
        const waitForCandidate = async (draft: {
          summary: string;
          candidate: typeof outcome.candidate;
          intent: typeof outcome.intent;
          renderJobId?: string;
          previewUrl?: string;
          attempt?: number;
        }): Promise<void> => {
          if (!draft.renderJobId) {
            await returnToFormalPreview();
            setNotice('候选草稿没有渲染任务，已保留草稿并返回正式副本');
            return;
          }
          const statusUrl = `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${workspace.workspaceId}/render-jobs/${draft.renderJobId}`;
            const deadline = Date.now() + 35_000;
            while (Date.now() < deadline) {
              await new Promise<void>(resolve => window.setTimeout(resolve, 700));
              const response = await fetchAgentService(statusUrl, { cache: 'no-store' }).catch(() => undefined);
              if (!response?.ok) continue;
              const status = renderJobStatusSchema.parse(await response.json());
              if (status.status === 'completed') {
                if (!status.result) {
                  await returnToFormalPreview();
                  setNotice('真实渲染任务未提供观察结果，候选草稿已保留，已返回正式副本');
                  await appendChat('assistant', '候选草稿未发布：真实渲染任务没有提供可用于验证的观察结果。候选草稿已保留，已返回正式副本。', undefined, workspace.revision);
                  return;
                }
                setNotice('真实渲染证据已收集，正在进行几何验证');
                setSourceProgress(current => current ? {
                  ...current,
                  status: 'running',
                  phase: 'validating',
                  message: '正在根据真实浏览器测量验证候选…',
                  updatedAt: new Date().toISOString()
                } : current);
                const validationAbort = new AbortController();
                repairValidationAbortRef.current = validationAbort;
                let validationResponse: Response | undefined;
                try {
                  validationResponse = await fetchAgentService(
                    `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${workspace.workspaceId}/candidates/${draft.candidate.candidateId}/geometry-validations`,
                    {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      signal: validationAbort.signal,
                      body: JSON.stringify({
                        workspaceId: workspace.workspaceId,
                        baseRevision: draft.candidate.baseRevision,
                        candidateId: draft.candidate.candidateId,
                        candidateVersion: draft.candidate.candidateVersion,
                        contentHash: draft.candidate.contentHash,
                        renderMode: draft.candidate.renderMode,
                        intentId: draft.intent.intentId,
                        intentVersion: draft.intent.version,
                        candidateObservationId: status.result.observationId,
                        summary: draft.summary,
                        commitId: crypto.randomUUID()
                      })
                    }
                  );
                } catch (error) {
                  if (validationAbort.signal.aborted) {
                    await returnToFormalPreview();
                    setNotice('已停止候选验证，候选草稿已保留，已返回正式副本');
                    await appendChat('assistant', '已停止候选验证，候选草稿未发布并已保留。', undefined, workspace.revision);
                    return;
                  }
                  throw error;
                } finally {
                  if (repairValidationAbortRef.current === validationAbort) repairValidationAbortRef.current = undefined;
                }
                if (!validationResponse) throw new Error('几何验证没有返回响应');
                if (!validationResponse.ok) throw await serviceResponseError(validationResponse, '几何验证返回');
                const verification = candidateGeometryValidationResultSchema.parse(await validationResponse.json());
                if (!verification.publication) {
                  const details = verification.validation.constraintResults
                    .filter(check => check.status !== 'passed')
                    .map(check => `${check.id}：${check.message}`)
                    .join('\n');
                  if (verification.repair) {
                    const repair = verification.repair;
                    if (repair.kind === 'clarification') {
                      await returnToFormalPreview();
                      const clarification = {
                        clarificationId: repair.clarificationId,
                        options: repair.options,
                        allowFreeText: repair.allowFreeText
                      };
                      setPendingClarification(clarification);
                      setNotice('自动修正需要你确认后才能继续，已返回正式副本');
                      await appendChat('assistant', repair.question, clarification, workspace.revision);
                      return;
                    }
                    if (repair.kind === 'failed') {
                      await returnToFormalPreview();
                      setNotice('自动修正未完成，候选草稿已保留，已返回正式副本');
                      await appendChat('assistant', `自动修正未完成：${repair.message}。候选草稿已保留，已返回正式副本。`, undefined, workspace.revision);
                      return;
                    }
                    const repairedTab = await browser.tabs.update(candidateTabId, { url: repair.previewUrl, active: true });
                    const repairedTabId = repairedTab?.id;
                    if (repairedTabId === undefined) throw new Error('修正候选标签页不可用');
                    await command({ type: 'bindEditorTab', tabId: repairedTabId, previewUrl: repair.previewUrl });
                    setSourceWorkspace(current => current ? { ...current, tabId: repairedTabId } : current);
                    setNotice(`第 ${repair.attempt} 次自动修正已生成，正在重新检查渲染结果`);
                    await appendChat('assistant', `几何验证发现可修正问题，已生成第 ${repair.attempt} 次自动修正候选，正在重新渲染验证。${details ? `\n${details}` : ''}`, undefined, workspace.revision);
                    await waitForCandidate(repair);
                    return;
                  }
                  await returnToFormalPreview();
                  setNotice(verification.validation.overall === 'unverifiable'
                    ? '当前证据不足以验证该需求，候选草稿已保留，已返回正式副本'
                    : '几何验证未通过，候选草稿已保留，已返回正式副本');
                  await appendChat(
                    'assistant',
                    `候选草稿未发布：${verification.validation.overall === 'unverifiable' ? '当前渲染证据不足以验证需求。' : '几何验证未通过。'}候选草稿已保留，已返回正式副本。${details ? `\n${details}` : ''}`,
                    undefined,
                    workspace.revision
                  );
                  return;
                }
                const workspaceResponse = await fetchAgentService(
                  `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${workspace.workspaceId}`,
                  { cache: 'no-store' }
                );
                if (!workspaceResponse.ok) throw await serviceResponseError(workspaceResponse, '刷新正式副本返回');
                const published = sourceWorkspaceInfoSchema.parse(await workspaceResponse.json());
                const publishedTab = await browser.tabs.update(candidateTabId, { url: published.previewUrl, active: true });
                const publishedTabId = publishedTab?.id;
                if (publishedTabId === undefined) throw new Error('正式副本标签页不可用');
                await command({ type: 'bindEditorTab', tabId: publishedTabId, previewUrl: published.previewUrl });
                setSourceWorkspace(current => current ? { ...published, tabId: publishedTabId } : current);
                setNotice('几何验证通过，已保存正式 Revision');
                await appendChat('assistant', `${draft.summary}。已完成真实几何验证并保存为 Revision ${verification.publication.revision}。`, undefined, verification.publication.revision);
                return;
              }
              if (status.status === 'failed' || status.status === 'cancelled') {
                await returnToFormalPreview();
                setNotice(`候选草稿未完成渲染：${status.failure ?? status.status}；已返回正式副本`);
                await appendChat('assistant', `候选草稿未完成渲染：${status.failure ?? status.status}。候选草稿已保留，已返回正式副本。`, undefined, workspace.revision);
                return;
              }
            }
            await returnToFormalPreview();
            setNotice('候选草稿等待渲染超时，已保留草稿并返回正式副本');
            await appendChat('assistant', '候选草稿未发布：等待真实渲染超时。候选草稿已保留，已返回正式副本。', undefined, workspace.revision);
        };
        try {
          await waitForCandidate(outcome);
          settled = true;
        } catch (error) {
          await returnToFormalPreview().catch(() => undefined);
          throw error;
        }
        return;
      }
      await applyCompletedDirectTurn(outcome, workspace, activeTurn.assistantEntryId);
      settled = true;
    } catch (error) {
      fail(error);
    } finally {
      setSnapshotBusy(false);
      if (settled || !requestMayHaveStarted) {
        setSourceProgress(undefined);
        setActiveSourceTurn(undefined);
        await clearPersistedActiveSourceTurn(workspace.workspaceId, activeTurn.turnId).catch(() => undefined);
      } else {
        resumedTurnIdsRef.current.delete(turnId);
        setRecoveryAttempt(attempt => attempt + 1);
      }
    }
  };

  const cancelSourceTurn = async () => {
    if (!sourceWorkspace || !sourceProgress || sourceProgress.status !== 'running') return;
    if (repairValidationAbortRef.current) {
      repairValidationAbortRef.current.abort(new Error('用户停止候选验证'));
      setSourceProgress(current => current ? {
        ...current,
        status: 'cancelling',
        phase: 'finishing',
        message: '正在停止候选验证…',
        updatedAt: new Date().toISOString()
      } : current);
      return;
    }
    try {
      const response = await fetchAgentService(
        `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${sourceWorkspace.workspaceId}/turns/${sourceProgress.turnId}/cancel`,
        { method: 'POST' }
      );
      if (!response.ok) throw await serviceResponseError(response, '停止源码 Agent 返回');
      setSourceProgress(current => current ? {
        ...current,
        status: 'cancelling',
        phase: 'finishing',
        message: '正在停止本轮修改…'
      } : current);
    } catch (error) {
      fail(error);
    }
  };
  const resumeSourceTurn = async (workspace: ActiveWorkspace, activeTurn: ActiveSourceTurnSession) => {
    let settled = false;
    setSnapshotBusy(true);
    setSourceProgress({
      workspaceId: workspace.workspaceId,
      turnId: activeTurn.turnId,
      status: 'running',
      phase: 'finishing',
      message: '正在恢复上次修改任务…',
      modelCalls: 0,
      toolCalls: 0,
      updatedAt: new Date().toISOString(),
      activities: []
    });
    try {
      {
        const progress = await waitForSourceTurn(workspace.workspaceId, activeTurn.turnId);
        if (!progress) {
          const refreshed = await refreshFormalWorkspace(workspace);
          const message = '上次修改任务的运行状态无法恢复，服务可能已重启。当前已保存的副本版本仍可继续编辑。';
          setNotice(message);
          await appendChat('assistant', message, undefined, refreshed.revision, activeTurn.assistantEntryId);
          await command({ type: 'reloadPreview' });
          settled = true;
          return;
        }
        const outcome = progress.result;
        if (!outcome) throw new Error('已恢复的修改任务缺少最终结果');
        if (outcome.kind === 'completed') {
          await applyCompletedDirectTurn(outcome, workspace, activeTurn.assistantEntryId);
        } else if (outcome.kind === 'cancelled') {
          await appendChat('assistant', outcome.message, undefined, workspace.revision, activeTurn.assistantEntryId);
        } else if (outcome.kind === 'clarification') {
          const clarification = {
            clarificationId: outcome.clarificationId ?? crypto.randomUUID(),
            options: outcome.options,
            allowFreeText: outcome.allowFreeText
          };
          setPendingClarification(clarification);
          await appendChat('assistant', outcome.question, clarification, workspace.revision, activeTurn.assistantEntryId);
        } else if (outcome.kind === 'failed') {
          await appendChat('assistant', `本轮修改未完成：${outcome.message}`, undefined, workspace.revision, activeTurn.assistantEntryId);
        } else {
          const refreshed = await refreshFormalWorkspace(workspace);
          await appendChat('assistant', '上次任务生成了未发布候选草稿；当前已返回正式副本。', undefined, refreshed.revision, activeTurn.assistantEntryId);
        }
        settled = true;
        return;
      }
    } catch (error) {
      fail(error);
    } finally {
      setSnapshotBusy(false);
      if (settled) {
        setSourceProgress(undefined);
        setActiveSourceTurn(undefined);
        await clearPersistedActiveSourceTurn(workspace.workspaceId, activeTurn.turnId).catch(() => undefined);
      } else {
        setNotice('暂时无法确认修改结果，正在重试连接。任务恢复后可继续编辑。');
        resumedTurnIdsRef.current.delete(activeTurn.turnId);
        setRecoveryAttempt(attempt => attempt + 1);
      }
    }
  };

  const createSourceWorkspace = async () => {
    setSnapshotBusy(true);
    try {
      const result = await command({
        type: 'createWorkspaceFromVisibleViewport'
      });
      const workspace = result.workspace;
      if (!workspace) throw new Error('副本已创建，但后台没有返回工作区信息');
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('副本已创建，但预览标签页不可用');
      // The background persisted this before navigating the tab. It is useful
      // for continuity, but creation must not fail if storage propagation lags.
      const persisted = await sourceWorkspaceSessionItem.getValue(workspace.workspaceId);
      await command({ type: 'bindEditorTab', tabId: tab.id, previewUrl: workspace.previewUrl });
      setSourceWorkspace({
        ...workspace,
        tabId: tab.id,
        sourceTabId: persisted?.sourceTabId ?? tab.id
      });
      setChat(persisted?.chat ?? []);
      setPendingClarification(persisted?.pendingClarification);
      setEditSessionId(persisted?.editSessionId ?? crypto.randomUUID());
      setSessionReady(true);
      setSnapshotBusy(false);
    } catch (error) {
      fail(error);
      setSnapshotBusy(false);
    }
  };
  const fail = (error: unknown) => {
    setError(error instanceof Error ? error.message : '操作失败');
    setNotice(undefined);
  };
  useEffect(() => {
    if (!sourceWorkspace || !activeSourceTurn || !sessionReady) return;
    if (resumedTurnIdsRef.current.has(activeSourceTurn.turnId)) return;
    const timer = window.setTimeout(() => {
      resumedTurnIdsRef.current.add(activeSourceTurn.turnId);
      setError(undefined);
      setNotice(undefined);
      void resumeSourceTurn(sourceWorkspace, activeSourceTurn);
    }, recoveryAttempt === 0 ? 0 : Math.min(1000 * 2 ** Math.min(recoveryAttempt, 4), 15_000));
    return () => window.clearTimeout(timer);
  }, [sourceWorkspace?.workspaceId, activeSourceTurn?.turnId, recoveryAttempt, sessionReady]);
  const openLogs = async () => {
    await browser.tabs.create({ url: `${browser.runtime.getURL('')}logs.html` });
  };
  const examples = ['把按钮文案改成“确定”', '在右侧增加一个筛选项', '点击按钮时展开下方内容'];

  return (
    <main className="panel">
      <section className="workspace">
        <div className="conversation-header">
          <span>{sourceWorkspace ? '静态副本' : '新建 UI 示意'}</span>
          <div className="conversation-meta">
            <div className="more-menu-wrap">
              <Button
                className="header-back"
                type="text"
                size="small"
                icon={<UiIcon name="more" />}
                onClick={() => setMoreOpen(value => !value)}
              >
                更多
              </Button>
              {moreOpen && <div className="more-menu">
                <button type="button" onClick={() => { setMoreOpen(false); void openWorkspaceManager(); }}><UiIcon name="snapshot" />副本</button>
                <button type="button" onClick={() => { setMoreOpen(false); void openLogs(); }}><UiIcon name="snapshot" />日志</button>
              </div>}
            </div>
            <Tooltip title={`Agent Service：${serviceUrl}`}>
              <span className={`service-status ${serviceStatus}`}><i />{serviceStatus === 'connected' ? '已连接' : serviceStatus === 'checking' ? '连接中' : '未连接'}</span>
            </Tooltip>
          </div>
        </div>

        {sourceWorkspace && (
          <div className={`selection-strip ${selection ? 'has-selection' : ''}`}>
            <span className="selection-symbol"><UiIcon name="target" /></span>
            <div className="selection-copy">
              <span className="selection-label">{selection ? '当前选区' : '选择编辑区域'}</span>
              <span className="selection-value">
                {selection
                  ? `${selection.selected.tag} · ${selection.selected.text || '无文本内容'}`
                  : '在静态副本中选择需要调整的元素'}
              </span>
            </div>
            <div className="selection-actions">
              <Button
                type="text"
                className="selection-action"
                icon={<UiIcon name="edit" />}
                disabled={busy}
                onClick={startSelection}
              >
                {selecting ? '选择中…' : selection ? '重选' : '选择'}
              </Button>
            </div>
          </div>
        )}

        <section className="chat-list">
          {!sourceWorkspace && (
            <div className="snapshot-welcome">
              <span className="empty-icon"><UiIcon name="snapshot" /></span>
              <strong>在静态副本中编辑当前页面</strong>
              <p>确认后会将当前标签页切换为静态副本。进入副本后再选择区域、描述改动，原页面不会受到影响。</p>
            </div>
          )}
          {sourceWorkspace && chat.length === 0 && (
            <div className="empty-tip">
              <span className="empty-icon"><UiIcon name="sparkle" /></span>
              <strong>{selection ? '描述你想看到的页面效果' : '先选择需要调整的区域'}</strong>
              <p>{selection ? '可以修改内容、样式和布局，或添加安全的点击交互。' : '点击上方“选择”，然后在静态副本页面中点击目标元素。'}</p>
              <div className="example-list">
                {examples.map(example => <button key={example} type="button" onClick={() => setInstruction(example)}>{example}</button>)}
              </div>
            </div>
          )}
          {sourceWorkspace && chat.map(entry => {
            const activeClarification = entry.clarification
              && pendingClarification?.clarificationId === entry.clarification.clarificationId;
            return (
              <div key={entry.id} className={`bubble ${entry.role}${entry.clarification ? ' clarification' : ''}`}>
                {entry.role === 'assistant' && !entry.clarification && entry.id !== streamingAnswerId
                  ? (
                      <Suspense fallback={<div className="markdown-streaming">{entry.text}</div>}>
                        <MarkdownMessage text={entry.text} />
                      </Suspense>
                    )
                  : <div className={entry.id === streamingAnswerId ? 'markdown-streaming' : undefined}>{entry.text}</div>}
                {entry.clarification?.options && (
                  <div className="clarification-options">
                    {entry.clarification.options.map(option => (
                      <button
                        key={option.id}
                        type="button"
                        disabled={!activeClarification || busy}
                        onClick={() => void submitText(
                          option.label,
                          entry.clarification?.clarificationId,
                          option.id
                        )}
                      >
                        <strong>{option.label}</strong>
                        {option.description && <span>{option.description}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {entry.clarification && !activeClarification && (
                  <span className="clarification-resolved">已回答</span>
                )}
              </div>
            );
          })}
          {busy && sourceWorkspace && snapshotBusy && sourceProgress ? (
            <div className="agent-progress-card">
              <div className="agent-progress-head">
                <Spin size="small" />
                <div>
                  <strong>{sourceProgress.message}</strong>
                  <span>已进行 {sourceProgress.modelCalls} 轮分析 · {sourceProgress.toolCalls} 次工具操作</span>
                </div>
              </div>
              {sourceProgress.activities.length > 0 && (
                <div className="agent-progress-list">
                  {sourceProgress.activities.slice(-5).map(activity => (
                    <div key={activity.id} className={`agent-progress-item ${activity.status}`}>
                      <i />
                      <span>{activity.label}{activity.detail ? ` · ${activity.detail}` : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : sourceWorkspace && assistantBusy && !streamingAnswerId ? (
            <div className="bubble assistant working">
              <Spin size="small" />
              <span>正在理解你的问题…</span>
            </div>
          ) : snapshotBusy && sourceWorkspace && (
            <div className="bubble assistant working">
              <Spin size="small" />
              <span>正在读取并修改静态源码…</span>
            </div>
          )}
          {notice && <Alert className="inline-alert" type="info" showIcon message={notice} closable onClose={() => setNotice(undefined)} />}
          {error && <Alert className="inline-alert" type="error" showIcon message={error} closable onClose={() => setError(undefined)} />}
        </section>

        {!sourceWorkspace && (
          <div className="source-workspace-cta">
            <div className="source-workspace-primary">
              <Button
                block
                type="primary"
                icon={<UiIcon name="snapshot" />}
                disabled={busy}
                loading={snapshotBusy}
                onClick={createSourceWorkspace}
              >
                进入副本编辑
              </Button>
              <span>在当前标签页打开可编辑副本</span>
            </div>
          </div>
        )}

        {sourceWorkspace && <footer className="composer-shell">
          <Input.TextArea
            ref={composerRef}
            value={instruction}
            variant="borderless"
            onChange={event => setInstruction(event.target.value)}
            disabled={Boolean(pendingClarification && !pendingClarification.allowFreeText)}
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder={pendingClarification
              ? pendingClarification.allowFreeText
                ? '选择一个方案，或直接补充你的要求…'
                : '请从上方选择一个方案'
              : '可以直接提问，也可以描述希望怎样修改页面…'}
            onPressEnter={event => { if (!event.shiftKey) { event.preventDefault(); void submit(); } }}
          />
          <div className="composer-toolbar">
            {sourceWorkspace ? (
              <div className="history-actions">
                <Tooltip title="撤销"><Button type="text" shape="circle" aria-label="撤销" disabled={!sourceWorkspace.canUndo || busy} icon={<UiIcon name="undo" />} onClick={() => history('undo')} /></Tooltip>
                <Tooltip title="重做"><Button type="text" shape="circle" aria-label="重做" disabled={!sourceWorkspace.canRedo || busy} icon={<UiIcon name="redo" />} onClick={() => history('redo')} /></Tooltip>
                <Tooltip title="恢复初始"><Button type="text" shape="circle" aria-label="恢复初始" disabled={!sourceWorkspace.canUndo || busy} icon={<UiIcon name="reset" />} onClick={() => history('reset')} /></Tooltip>
                <Tooltip title="导出当前可视区域"><Button className="export-action" type="text" shape="circle" aria-label="导出截图" disabled={busy} icon={<UiIcon name="download" />} onClick={exportScreenshot} /></Tooltip>
              </div>
            ) : <div />}
            {sourceProgress && (sourceProgress.status === 'running' || sourceProgress.status === 'cancelling') ? (
              <Tooltip title={sourceProgress.status === 'cancelling' ? '正在停止' : '停止生成'}>
                <Button
                  className="send-button stop-button"
                  type="primary"
                  shape="circle"
                  aria-label={sourceProgress.status === 'cancelling' ? '正在停止' : '停止生成'}
                  disabled={sourceProgress.status === 'cancelling'}
                  loading={sourceProgress.status === 'cancelling'}
                  icon={sourceProgress.status === 'running' ? <UiIcon name="stop" /> : undefined}
                  onClick={() => void cancelSourceTurn()}
                />
              </Tooltip>
            ) : (
              <Tooltip title="发送">
                <Button
                  className="send-button"
                  type="primary"
                  shape="circle"
                  aria-label="发送"
                  disabled={
                    busy
                    || !instruction.trim()
                    || Boolean(pendingClarification && !pendingClarification.allowFreeText)
                  }
                  loading={busy}
                  icon={!busy && <UiIcon name="arrow" />}
                  onClick={submit}
                />
              </Tooltip>
            )}
          </div>
        </footer>}
      </section>

      <Modal
        title={`必须更新 UI 需求示意助手至 v${availableUpdate?.version ?? ''}`}
        open={Boolean(availableUpdate)}
        okText="下载更新包"
        cancelButtonProps={{ style: { display: 'none' } }}
        closable={false}
        keyboard={false}
        maskClosable={false}
        onOk={() => {
          if (!availableUpdate) return;
          void browser.downloads.download({
            url: availableUpdate.downloadUrl,
            filename: `ui-agent-extension-${availableUpdate.version}.zip`,
            saveAs: true
          }).catch(fail);
        }}
      >
        <p>当前版本已停止使用，请完成更新并在 Chrome 扩展程序页面重新加载。</p>
        {availableUpdate?.releaseNotes && <p className="extension-update-notes">{availableUpdate.releaseNotes}</p>}
        <ol className="extension-update-steps">
          <li>下载并解压 ZIP。</li>
          <li>用新文件覆盖原来的插件目录，不要卸载现有插件。</li>
          <li>打开 chrome://extensions，在本插件卡片上点击“重新加载”。</li>
        </ol>
      </Modal>

    </main>
  );
}
