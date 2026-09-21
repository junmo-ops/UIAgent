import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Tooltip, message } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import {
  type SourceTurnRequest,
  PROTOCOL_VERSION,
  assistantTurnRequestSchema,
  assistantTurnResponseSchema,
  sourceTurnRequestSchema,
  sourceTurnAcceptedSchema,
  sourceTurnProgressSchema,
  sourceTurnTranscriptSchema,
  sourceWorkspaceCreatedSchema,
  sourceWorkspaceInfoSchema,
  workspaceChatEntrySchema,
  workspaceConversationResponseSchema,
  workspaceConversationSchema,
  workspaceConversationsSchema,
  type WorkspaceConversation,
  type AssistantTurnResponse,
  type ContentCommand,
  type ContentCommandResult,
  type PageSelection,
  type SourceWorkspaceInfo,
  type SourceTurnResponse,
  type SourceTurnProgress
} from '@ui-agent/contracts';
import { onMessage, sendMessage } from '../messaging';
import { SourceTurnProgressCard } from './SourceTurnProgressCard';
import { MarkdownMessage } from './MarkdownMessage';
import { createSourceTurnResultHandler } from './source-turn-result';
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

// 本地 Side Panel 关闭时，Background 通过 Port 断开清理选区。
const editorClientId = crypto.randomUUID();
const editorPort = browser.runtime.connect({ name: `ui-agent-editor:${editorClientId}` });
void editorPort;

type ClarificationPrompt = WorkspaceClarificationPrompt;
type ChatEntry = WorkspaceChatEntry;
interface ActiveWorkspace extends SourceWorkspaceInfo {
  tabId: number;
  sourceTabId?: number;
}
type IconName = 'sparkle' | 'target' | 'edit' | 'snapshot' | 'undo' | 'redo' | 'reset' | 'download' | 'upload' | 'arrow' | 'stop' | 'back' | 'history' | 'logs' | 'userId' | 'newChat' | 'search' | 'trash' | 'close';

function UiIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
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
    history: <><path d="M4 5h16v12H9l-5 4V5Z" /><path d="M8 9h8M8 13h5" /></>,
    logs: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
    userId: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8" cy="10" r="2" /><path d="M5 16a3 3 0 0 1 6 0M14 10h4M14 14h4" /></>,
    newChat: <><path d="M4 5h16v12H9l-5 4V5Z" /><path d="M9 11h6m-3-3v6" /></>
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

async function fetchCurrentIdentity(signal?: AbortSignal): Promise<{ userId: string; roles: string[] }> {
  const url = await getAgentServiceUrl();
  const response = await fetchAgentService(`${url}/v1/auth/me`, { signal });
  if (!response.ok) throw await serviceResponseError(response, '获取当前身份失败');
  const identity: unknown = await response.json();
  if (!identity || typeof identity !== 'object' || !('userId' in identity)
    || typeof identity.userId !== 'string' || !identity.userId.trim()) {
    throw new Error('服务未返回有效的用户 ID');
  }
  return {
    userId: identity.userId,
    roles: 'roles' in identity && Array.isArray(identity.roles)
      ? identity.roles.filter((role): role is string => typeof role === 'string') : []
  };
}

/** Accept a committed workspace preview. */
function previewWorkspaceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const path = new URL(value).pathname;
    const match = /^\/workspaces\/([0-9a-f-]{36})\/preview\/?$/i.exec(path);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function SidePanelApp() {
  const [feedback, feedbackHolder] = message.useMessage();
  const copyingUserIdRef = useRef(false);
  const [instruction, setInstruction] = useState('');
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [conversations, setConversations] = useState<WorkspaceConversation[]>([]);
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const [historyPreview, setHistoryPreview] = useState<{ conversation: WorkspaceConversation; entries: ChatEntry[] }>();
  const [conversationLoading, setConversationLoading] = useState(false);
  const conversationRequestRef = useRef(0);
  const conversationSwitchRef = useRef(false);
  const draftsRef = useRef<Record<string, string>>({});
  const [selection, setSelection] = useState<PageSelection>();
  const [selecting, setSelecting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [serviceUrl, setServiceUrl] = useState(DEFAULT_AGENT_SERVICE_URL);
  const [isAdmin, setIsAdmin] = useState(false);
  const [editSessionId, setEditSessionId] = useState<string>(() => crypto.randomUUID());
  const [sourceWorkspace, setSourceWorkspace] = useState<ActiveWorkspace>();
  const [sourceProgress, updateSourceProgress] = useState<SourceTurnProgress>();
  const sourceProgressRef = useRef<SourceTurnProgress | undefined>(undefined);
  const sourceAnswerIdRef = useRef<string | undefined>(undefined);
  const assistantAbortRef = useRef<AbortController | undefined>(undefined);
  const setSourceProgress = (value: SourceTurnProgress | undefined | ((current: SourceTurnProgress | undefined) => SourceTurnProgress | undefined)) => {
    const next = typeof value === 'function' ? value(sourceProgressRef.current) : value;
    sourceProgressRef.current = next;
    updateSourceProgress(next);
  };
  const [activeSourceTurn, setActiveSourceTurn] = useState<ActiveSourceTurnSession>();
  const [pendingClarification, setPendingClarification] = useState<ClarificationPrompt>();
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [streamingAnswerId, setStreamingAnswerId] = useState<string>();
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<ExtensionUpdateInfo>();
  const composerRef = useRef<TextAreaRef>(null);
  const resumedTurnIdsRef = useRef(new Set<string>());
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [initialization, setInitialization] = useState<'restoring' | 'ready' | 'failed'>('restoring');
  const [initializationError, setInitializationError] = useState<string>();
  const initialTabIdRef = useRef<number | undefined>(undefined);
  const restoredMessageIdsRef = useRef(new Set<string>());
  const [sessionReady, setSessionReady] = useState(false);
  const busy = snapshotBusy || assistantBusy || conversationLoading || Boolean(activeSourceTurn) || Boolean(sourceWorkspace && !sessionReady);
  useEffect(() => {
    const controller = new AbortController();
    setIsAdmin(false);
    void fetchCurrentIdentity(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
      .then(identity => { if (!controller.signal.aborted) setIsAdmin(identity.roles.includes('admin')); })
      .catch(() => { if (!controller.signal.aborted) setIsAdmin(false); });
    return () => controller.abort();
  }, [serviceUrl, initializationAttempt]);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const failed = (cause: unknown) => {
      if (disposed) return;
      setInitializationError(cause instanceof Error ? cause.message : '会话恢复失败，请重试');
      setInitialization('failed');
    };
    setInitialization('restoring');
    setInitializationError(undefined);
    getAgentServiceUrl().then(async url => {
      if (disposed) return;
      setServiceUrl(url);
      const tab = initialTabIdRef.current === undefined
        ? (await browser.tabs.query({ active: true, currentWindow: true }))[0]
        : await browser.tabs.get(initialTabIdRef.current);
      if (disposed) return;
      if (tab?.id === undefined) throw new Error('当前标签页不可用，请重新打开插件');
      initialTabIdRef.current = tab.id;
      const workspaceId = previewWorkspaceId(tab?.url);
      if (!workspaceId || !tab.url) { setInitialization('ready'); return; }
      try {
        const [response, conversationResponse, persisted] = await Promise.all([
          fetchAgentService(`${url.replace(/\/$/, '')}/v1/workspaces/${workspaceId}`, { signal }),
          fetchAgentService(`${url.replace(/\/$/, '')}/v1/workspaces/${workspaceId}/conversations`, { signal }),
          sourceWorkspaceSessionItem.getValue(workspaceId)
        ]);
        if (response.status === 404) {
          throw new Error('该副本不存在或当前账号无法访问');
        }
        if (!response.ok || !conversationResponse.ok) throw new Error('副本服务暂不可用');
        if (disposed) return;
        const workspace = sourceWorkspaceInfoSchema.parse(await response.json());
        const restoredWorkspace = persisted?.workspace.workspaceId === workspace.workspaceId
          ? { ...workspace, selectedSourceId: persisted.workspace.selectedSourceId }
          : workspace;
        const available = workspaceConversationsSchema.parse(await conversationResponse.json()).conversations;
        const preferred = persisted?.activeSourceTurn?.conversationId ?? persisted?.conversationId ?? workspaceId;
        const selected = available.find(item => item.id === preferred)?.id ?? available[0]?.id ?? workspaceId;
        const historyResponse = await fetchAgentService(`${url.replace(/\/$/, '')}/v1/workspaces/${workspaceId}/conversation?conversationId=${encodeURIComponent(selected)}`, { signal });
        if (!historyResponse.ok) throw new Error('读取会话失败');
        const serverConversation = workspaceConversationResponseSchema.parse(await historyResponse.json()).entries;
        if (disposed) return;
        await command({ type: 'bindEditorTab', tabId: tab.id, previewUrl: tab.url });
        if (disposed) return;
        // Publish the complete restored state in one React batch, after all awaits.
        restoredMessageIdsRef.current = new Set(serverConversation.map(entry => entry.id));
        setSourceWorkspace({
          ...restoredWorkspace,
          tabId: tab.id,
          sourceTabId: persisted?.workspace.workspaceId === workspace.workspaceId ? persisted.sourceTabId : undefined
        });
        setConversationId(selected);
        setConversations(available);
        draftsRef.current = persisted?.drafts ?? {};
        setInstruction(draftsRef.current[selected] ?? '');
        {
          setChat(serverConversation);
          const unresolved = [...serverConversation].reverse().find(entry => (
            entry.clarification && !entry.clarification.resolved
          ));
          setPendingClarification(unresolved?.clarification);
        }
        if (persisted?.workspace.workspaceId === workspace.workspaceId) {
          setEditSessionId(persisted.editSessionId);
          if ((persisted.conversationId ?? workspaceId) === selected && persisted.activeSourceTurn) setPendingClarification(persisted.pendingClarification);
          setActiveSourceTurn(persisted.activeSourceTurn);
        }
        setSessionReady(true);
        setNotice(undefined);
        setInitialization('ready');
      } catch (cause) { failed(cause); }
    }).catch(failed);
    return () => { disposed = true; controller.abort(); };
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
      conversationId,
      drafts: { ...draftsRef.current, ...(conversationId ? { [conversationId]: instruction } : {}) },
      workspace,
      chat,
      editSessionId,
      sourceTabId: sourceWorkspace.sourceTabId,
      pendingClarification,
      activeSourceTurn
    });
  }, [sourceWorkspace, chat, editSessionId, pendingClarification, activeSourceTurn, sessionReady, conversationId, instruction]);
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
      conversationId: conversationId ?? workspace?.workspaceId,
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
    const progress = sourceProgressRef.current;
    const entry: ChatEntry = { id: entryId, role, text, ...(clarification && { clarification }),
      ...(role === 'assistant' && entryId === sourceAnswerIdRef.current && progress
        && progress.status !== 'running' && progress.status !== 'cancelling'
        ? { progress: sourceTurnTranscriptSchema.parse(progress) } : {}) };
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
    setSourceProgress(undefined);
    const turnId = crypto.randomUUID();
    await appendChat('user', text, undefined, undefined, turnId);
    setInstruction('');
    if (replyToClarificationId) setPendingClarification(undefined);
    setAssistantBusy(true);
    const assistantAbort = new AbortController();
    assistantAbortRef.current = assistantAbort;
    let streamedEntryId: string | undefined;
    let streamedText = '';
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
        signal: assistantAbort.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      });
      if (!response.ok) throw await serviceResponseError(response, '智能助手返回');
      let outcome: AssistantTurnResponse | undefined;
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
      if (assistantAbort.signal.aborted) throw new Error('已停止');
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
        { replyToClarificationId, clarificationOptionId, originalInstruction: text, assistantTraceId: request.traceId }
      );
    } catch (error) {
      if (assistantAbort.signal.aborted) {
        const stopped: ChatEntry = { id: streamedEntryId ?? crypto.randomUUID(), role: 'assistant',
          text: streamedText ? `${streamedText}\n\n已停止生成。` : '已停止。' };
        setChat(entries => streamedEntryId ? entries.map(entry => entry.id === stopped.id ? stopped : entry) : [...entries, stopped]);
        await persistWorkspaceChat(stopped).catch(fail);
      } else fail(error);
    } finally {
      if (assistantAbortRef.current === assistantAbort) assistantAbortRef.current = undefined;
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
        `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${sourceWorkspace.workspaceId}/conversation?conversationId=${encodeURIComponent(conversationId ?? sourceWorkspace.workspaceId)}`,
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
  const handleSourceTurnResult = createSourceTurnResultHandler<ActiveWorkspace>({
    refresh: refreshFormalWorkspace,
    reload: () => command({ type: 'reloadPreview' }),
    append: (text, clarification, revision, entryId) => appendChat('assistant', text, clarification, revision, entryId),
    clarify: setPendingClarification
  });
  const persistActiveSourceTurn = async (workspace: ActiveWorkspace, activeTurn: ActiveSourceTurnSession) => {
    const { tabId: _tabId, sourceTabId: _sourceTabId, ...persistedWorkspace } = workspace;
    const existing = await sourceWorkspaceSessionItem.getValue(workspace.workspaceId);
    await sourceWorkspaceSessionItem.setValue({
      conversationId: activeTurn.conversationId,
      drafts: existing?.drafts ?? draftsRef.current,
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
    requestContext: Pick<SourceTurnRequest, 'replyToClarificationId' | 'clarificationOptionId' | 'originalInstruction' | 'assistantTraceId'> = {}
  ) => {
    setSnapshotBusy(true);
    let settled = false;
    let requestMayHaveStarted = false;
    setRecoveryAttempt(0);
    const activeTurn: ActiveSourceTurnSession = {
      conversationId: conversationId ?? workspace.workspaceId,
      turnId,
      instruction: text,
      baseRevision: workspace.revision,
      assistantEntryId: crypto.randomUUID(),
      startedAt: new Date().toISOString()
    };
    resumedTurnIdsRef.current.add(turnId);
    sourceAnswerIdRef.current = activeTurn.assistantEntryId;
    setActiveSourceTurn(activeTurn);
    try {
      await persistActiveSourceTurn(workspace, activeTurn);
      const request = sourceTurnRequestSchema.parse({
        conversationId: conversationId ?? workspace.workspaceId,
        protocolVersion: PROTOCOL_VERSION,
        editSessionId,
        turnId,
        traceId: crypto.randomUUID(),
        instruction: text,
        sourceId,
        ...requestContext
      });
      setSourceProgress({
        workspaceId: workspace.workspaceId,
        turnId: request.turnId,
        status: 'running',
        phase: 'analyzing',
        message: '正在理解修改目标…',
        startedAt: activeTurn.startedAt,
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
      await handleSourceTurnResult(outcome, workspace, activeTurn.assistantEntryId);
      settled = true;
    } catch (error) {
      fail(error);
    } finally {
      setSnapshotBusy(false);
      if (settled || !requestMayHaveStarted) {
        setSourceProgress(current => current?.status === 'running' || current?.status === 'cancelling' ? undefined : current);
        setActiveSourceTurn(undefined);
        await clearPersistedActiveSourceTurn(workspace.workspaceId, activeTurn.turnId).catch(() => undefined);
      } else {
        resumedTurnIdsRef.current.delete(turnId);
        setRecoveryAttempt(attempt => attempt + 1);
      }
    }
  };

  const cancelSourceTurn = async () => {
    if (assistantBusy && assistantAbortRef.current) {
      assistantAbortRef.current.abort();
      return;
    }
    if (!sourceWorkspace || !sourceProgress || sourceProgress.status !== 'running') return;
    try {
      const response = await fetchAgentService(
        `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${sourceWorkspace.workspaceId}/turns/${sourceProgress.turnId}/cancel`,
        { method: 'POST' }
      );
      if (!response.ok) throw await serviceResponseError(response, '停止源码 Agent 返回');
      setSourceProgress(current => current?.status === 'running' ? {
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
    sourceAnswerIdRef.current = activeTurn.assistantEntryId;
    let settled = false;
    setSnapshotBusy(true);
    setSourceProgress({
      workspaceId: workspace.workspaceId,
      turnId: activeTurn.turnId,
      status: 'running',
      phase: 'finishing',
      message: '正在恢复上次修改任务…',
      startedAt: activeTurn.startedAt,
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
          setSourceProgress(current => current ? { ...current, status: 'failed', execution: 'settled',
            saveState: 'unconfirmed', message, updatedAt: new Date().toISOString() } : current);
          setNotice(message);
          await appendChat('assistant', message, undefined, refreshed.revision, activeTurn.assistantEntryId);
          await command({ type: 'reloadPreview' });
          settled = true;
          return;
        }
        const outcome = progress.result;
        if (!outcome) throw new Error('已恢复的修改任务缺少最终结果');
        await handleSourceTurnResult(outcome, workspace, activeTurn.assistantEntryId);
        settled = true;
        return;
      }
    } catch (error) {
      fail(error);
    } finally {
      setSnapshotBusy(false);
      if (settled) {
        setSourceProgress(current => current?.status === 'running' || current?.status === 'cancelling' ? undefined : current);
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
      setConversationId(persisted?.conversationId ?? workspace.workspaceId);
      setConversations([]);
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
  const copyUserId = async () => {
    if (copyingUserIdRef.current) return;
    copyingUserIdRef.current = true;
    void feedback.loading({ key: 'copy-user-id', content: '正在获取用户 ID…', duration: 0 });
    try {
      const identity = await fetchCurrentIdentity(AbortSignal.timeout(15_000));
      setIsAdmin(identity.roles.includes('admin'));
      const userId = identity.userId;
      try {
        await navigator.clipboard.writeText(userId);
        void feedback.success({ key: 'copy-user-id', content: '用户 ID 已复制', duration: 3 });
      } catch {
        feedback.destroy('copy-user-id');
        Modal.info({
          title: '请手动复制用户 ID',
          content: <Input aria-label="当前用户 ID" value={userId} readOnly onFocus={event => event.currentTarget.select()} />,
          okText: '关闭'
        });
      }
    } catch (cause) {
      void feedback.error({ key: 'copy-user-id', content: cause instanceof Error ? cause.message : '获取用户 ID 失败', duration: 5 });
    } finally {
      copyingUserIdRef.current = false;
    }
  };
  const examples = ['把按钮文案改成“确定”', '在右侧增加一个筛选项', '点击按钮时展开下方内容'];

  const closeConversations = () => {
    ++conversationRequestRef.current;
    setConversationsOpen(false);
    setHistoryPreview(undefined);
    setHistoryLoading(false);
    historyButtonRef.current?.focus();
  };
  const openConversations = async () => {
    if (!sourceWorkspace) return;
    const requestId = ++conversationRequestRef.current;
    setConversationsOpen(true);
    setHistoryPreview(undefined);
    setHistorySearch('');
    setHistoryLoading(true);
    try {
      const response = await fetchAgentService(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${sourceWorkspace.workspaceId}/conversations`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw await serviceResponseError(response, '读取会话列表返回');
      const available = workspaceConversationsSchema.parse(await response.json()).conversations;
      if (requestId === conversationRequestRef.current) setConversations(available);
    } catch (error) { if (requestId === conversationRequestRef.current) fail(error); }
    finally { if (requestId === conversationRequestRef.current) setHistoryLoading(false); }
  };
  const previewConversation = async (conversation: WorkspaceConversation) => {
    if (!sourceWorkspace) return;
    const requestId = ++conversationRequestRef.current;
    setHistoryPreview(undefined);
    setHistoryLoading(true);
    try {
      const response = await fetchAgentService(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${sourceWorkspace.workspaceId}/conversation?conversationId=${conversation.id}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw await serviceResponseError(response, '读取历史会话返回');
      const entries = workspaceConversationResponseSchema.parse(await response.json()).entries;
      if (requestId === conversationRequestRef.current) setHistoryPreview({ conversation, entries });
    } catch (error) { if (requestId === conversationRequestRef.current) fail(error); }
    finally { if (requestId === conversationRequestRef.current) setHistoryLoading(false); }
  };
  const changeConversation = async (target?: WorkspaceConversation) => {
    if (!sourceWorkspace || busy || conversationSwitchRef.current) return;
    conversationSwitchRef.current = true;
    setConversationLoading(true);
    try {
      const base = `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${sourceWorkspace.workspaceId}`;
      let selected = target;
      if (!selected) {
        const response = await fetchAgentService(`${base}/conversations`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw await serviceResponseError(response, '新建会话返回');
        selected = workspaceConversationSchema.parse(await response.json());
        setConversations(items => [...items, selected!]);
      }
      const [historyResponse, workspaceResponse] = await Promise.all([
        fetchAgentService(`${base}/conversation?conversationId=${selected.id}`, { signal: AbortSignal.timeout(15_000) }),
        fetchAgentService(base, { signal: AbortSignal.timeout(15_000) })
      ]);
      if (!historyResponse.ok || !workspaceResponse.ok) throw new Error('暂时无法切换会话，请重试');
      const entries = workspaceConversationResponseSchema.parse(await historyResponse.json()).entries;
      const latest = sourceWorkspaceInfoSchema.parse(await workspaceResponse.json());
      if (conversationId) draftsRef.current[conversationId] = instruction;
      if (latest.revision !== sourceWorkspace.revision) {
        await command({ type: 'reloadPreview' });
        setSelection(undefined);
      }
      setSourceWorkspace({ ...sourceWorkspace, ...latest });
      setConversationId(selected.id);
      setEditSessionId(crypto.randomUUID());
      setInstruction(draftsRef.current[selected.id] ?? '');
      setChat(entries);
      setPendingClarification([...entries].reverse().find(entry => entry.clarification && !entry.clarification.resolved)?.clarification);
      setSourceProgress(undefined);
      setError(undefined);
      setNotice(selected.lastRevision !== latest.revision
        ? '页面版本已更新。切换会话不会回滚页面，后续修改将基于当前副本。'
        : undefined);
      if (!target) void feedback.success({ key: 'conversation-action', content: '新会话已创建，页面与历史对话已保留', duration: 3 });
      ++conversationRequestRef.current;
      setConversationsOpen(false);
      setHistoryPreview(undefined);
    } catch (error) { fail(error); }
    finally { conversationSwitchRef.current = false; setConversationLoading(false); }
  };
  const deleteConversation = (target: WorkspaceConversation) => {
    if (!sourceWorkspace || busy || target.activeTurnId) return;
    Modal.confirm({
      title: '删除这段会话？',
      content: `将永久删除“${target.title}”的对话及处理过程，无法恢复。副本页面、修改版本和诊断日志不会删除。`,
      okText: '删除会话', cancelText: '取消', okButtonProps: { danger: true },
      onOk: async () => {
        if (conversationSwitchRef.current) throw new Error('正在处理会话操作，请稍后重试');
        conversationSwitchRef.current = true;
        setConversationLoading(true);
        ++conversationRequestRef.current;
        try {
          const response = await fetchAgentService(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${sourceWorkspace.workspaceId}/conversations/${target.id}`,
            { method: 'DELETE', signal: AbortSignal.timeout(15_000) });
          if (!response.ok) throw await serviceResponseError(response, '删除会话返回');
          const payload: unknown = await response.json();
          const remaining = workspaceConversationsSchema.parse(payload).conversations;
          const entries = workspaceConversationResponseSchema.parse(payload).entries;
          const next = remaining[0];
          if (!next) throw new Error('删除后未返回可用会话，请刷新侧栏');
          delete draftsRef.current[target.id];
          setConversations(remaining);
          setHistoryPreview(undefined);
          setError(undefined);
          if (target.id === conversationId) {
            setConversationId(next.id);
            setEditSessionId(crypto.randomUUID());
            setChat(entries);
            setInstruction(draftsRef.current[next.id] ?? '');
            setPendingClarification([...entries].reverse().find(entry => entry.clarification && !entry.clarification.resolved)?.clarification);
            setSourceProgress(undefined);
          }
          const persisted = await sourceWorkspaceSessionItem.getValue(sourceWorkspace.workspaceId);
          if (persisted) {
            const drafts = { ...persisted.drafts };
            delete drafts[target.id];
            await sourceWorkspaceSessionItem.setValue({ ...persisted, drafts,
              ...(persisted.conversationId === target.id ? { conversationId: next.id, chat: entries,
                pendingClarification: undefined, activeSourceTurn: undefined } : {}) });
          }
          void feedback.success({ key: 'conversation-action', content: '会话已删除，页面与修改版本保留', duration: 3 });
        } catch (error) { fail(error); throw error; }
        finally { conversationSwitchRef.current = false; setConversationLoading(false); }
      }
    });
  };
  const visibleConversations = [...conversations]
    .filter(item => `${item.title} ${item.preview ?? ''}`.toLocaleLowerCase().includes(historySearch.trim().toLocaleLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const conversationTitle = chat.find(entry => entry.role === 'user')?.text.slice(0, 40)
    ?? conversations.find(item => item.id === conversationId)?.title ?? '新会话';

  const recoveryView = (
    <main className="panel">
      <section className="workspace" aria-label="恢复会话">
        <header className="conversation-header"><div className="conversation-heading"><h1>UI需求助手</h1></div></header>
        <div className="session-recovery" role={initialization === 'failed' ? 'alert' : 'status'}>
          <p>{initialization === 'failed' ? initializationError : '正在恢复会话…'}</p>
          {initialization === 'failed' && <Button onClick={() => {
            setInitialization('restoring');
            setInitializationAttempt(value => value + 1);
          }}>重新连接</Button>}
        </div>
      </section>
    </main>
  );
  if (initialization !== 'ready') return recoveryView;

  return (
    <main className="panel">
      {feedbackHolder}
      {conversationsOpen && <section className="history-panel" aria-label="历史会话"
        onKeyDown={event => { if (event.key === 'Escape' && !conversationLoading) { event.stopPropagation(); closeConversations(); } }}>
        <header className="history-header">
          <h1>历史会话 <span>({conversations.length})</span></h1>
          <button className="history-icon-button" type="button" aria-label="关闭历史会话" onClick={closeConversations}><UiIcon name="close" /></button>
        </header>
        {error && <Alert type="error" message={error} />}
        {historyPreview ? <div className="conversation-preview">
          <div className="conversation-preview-heading">
            <button className="history-icon-button" type="button" aria-label="返回历史列表" onClick={() => setHistoryPreview(undefined)}><UiIcon name="back" /></button>
            <strong title={historyPreview.conversation.title}>{historyPreview.conversation.title}</strong>
            <Button type="text" size="small" disabled={busy}
              onClick={() => historyPreview.conversation.id === conversationId ? closeConversations() : void changeConversation(historyPreview.conversation)}>继续会话</Button>
          </div>
          {busy && <p className="history-hint">只读查看，不影响正在进行的任务。</p>}
          <div className="conversation-preview-messages">
            {historyPreview.entries.length === 0 && <p className="history-empty">还没有消息</p>}
            {historyPreview.entries.map(entry => <div key={entry.id} className={`bubble ${entry.role}`}>
              {entry.progress && <SourceTurnProgressCard progress={entry.progress} />}
              <MarkdownMessage text={entry.text} />
            </div>)}
          </div>
        </div> : <>
          <Input className="history-search" autoFocus allowClear prefix={<UiIcon name="search" />}
            aria-label="搜索会话标题和摘要" placeholder="搜索会话" value={historySearch}
            onChange={event => setHistorySearch(event.target.value)} />
          {busy && <p className="history-hint">任务进行中，可只读查看历史。</p>}
          <div className="conversation-list" aria-busy={historyLoading || conversationLoading}>
            {historyLoading ? <p className="history-empty" role="status">正在加载…</p> : <>
              {visibleConversations.length === 0 && <p className="history-empty">{historySearch.trim() ? '没有找到匹配的会话' : '暂无历史会话'}</p>}
              {visibleConversations.map(item => <div key={item.id} className={`conversation-list-row${item.id === conversationId ? ' is-current' : ''}`}>
                <button type="button" className="conversation-item" disabled={conversationLoading}
                  aria-current={item.id === conversationId ? 'true' : undefined}
                  title={item.title}
                  onClick={() => {
                    if (item.id === conversationId) closeConversations();
                    else if (busy) void previewConversation(item);
                    else void changeConversation(item);
                  }}>
                  <span className="conversation-item-heading"><strong>{item.title}</strong>{item.id === conversationId && <em>当前</em>}</span>
                  <small>{item.preview || '还没有消息'}</small>
                </button>
                <Tooltip title="删除会话"><button type="button" className="history-icon-button conversation-delete"
                  aria-label={`删除会话：${item.title}`} disabled={busy || Boolean(item.activeTurnId)}
                  onClick={() => deleteConversation(item)}><UiIcon name="trash" /></button></Tooltip>
              </div>)}
            </>}
          </div>
        </>}
      </section>}
      <section className="workspace" hidden={conversationsOpen}>
        <header className="conversation-header">
          <div className="conversation-heading">
            <h1 title={sourceWorkspace ? conversationTitle : undefined}>{sourceWorkspace ? conversationTitle : 'UI需求助手'}</h1>
          </div>
          {sourceWorkspace && <Tooltip title={busy ? '请等待当前任务完成或先停止，右侧可查看历史会话' : '保留当前页面和历史对话'}>
            <Button className="new-conversation-button" type="text" icon={<UiIcon name="newChat" />}
              disabled={busy} onClick={() => void changeConversation()}>新建会话</Button>
          </Tooltip>}
        </header>
        {sourceWorkspace && (
          <div className={`selection-strip ${selection ? 'has-selection' : ''}`}>
            <span className="selection-symbol"><UiIcon name="target" /></span>
            <div className="selection-copy">
              <span className="selection-label">{selection ? '当前选区' : '选择编辑区域'}</span>
              <span className="selection-value">
                {selection ? `${selection.selected.tag} · ${selection.selected.text || '无文本内容'}` : '在静态副本中选择需要调整的元素'}
              </span>
            </div>
            <div className="selection-actions">
              <Button type="text"
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
              <img className="brand-icon" src="/icons/logo.svg" width="42" height="42" alt="" />
              <strong>在静态副本中编辑当前页面</strong>
              <p>确认后会将当前标签页切换为静态副本。进入副本后再选择区域、描述改动，原页面不会受到影响。</p>
            </div>
          )}
          {sourceWorkspace && chat.length === 0 && (
            <div className="empty-tip">
              <img className="brand-icon" src="/icons/logo.svg" width="42" height="42" alt="" />
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
              <div key={entry.id} className={`bubble ${entry.role}${entry.clarification ? ' clarification' : ''}${restoredMessageIdsRef.current.has(entry.id) ? ' is-restored' : ''}`}>
                {entry.role === 'assistant' && entry.progress && <SourceTurnProgressCard progress={entry.progress} />}
                {entry.role === 'assistant' && !entry.clarification && entry.id !== streamingAnswerId
                  ? (
                      <MarkdownMessage text={entry.text} />
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
          {sourceWorkspace && sourceProgress?.workspaceId === sourceWorkspace.workspaceId
            && !chat.some(entry => entry.progress?.turnId === sourceProgress.turnId)
            && (snapshotBusy || !busy) ? (
            <SourceTurnProgressCard key={sourceProgress.turnId} progress={sourceProgress} />
          ) : sourceWorkspace && assistantBusy && !streamingAnswerId ? (
            <div className="bubble assistant working">
              <span role="status">正在思考…</span>
            </div>
          ) : snapshotBusy && sourceWorkspace && (
            <div className="bubble assistant working">
              <span role="status">正在思考…</span>
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
            {assistantBusy || sourceProgress && (sourceProgress.status === 'running' || sourceProgress.status === 'cancelling') ? (
              <Tooltip title={sourceProgress?.status === 'cancelling' ? '正在停止' : '停止生成'}>
                <Button
                  className="send-button stop-button"
                  type="primary"
                  shape="circle"
                  aria-label={sourceProgress?.status === 'cancelling' ? '正在停止' : '停止生成'}
                  disabled={sourceProgress?.status === 'cancelling'}
                  loading={sourceProgress?.status === 'cancelling'}
                  icon={sourceProgress?.status !== 'cancelling' ? <UiIcon name="stop" /> : undefined}
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

      <nav className="side-tools" aria-label="辅助工具">
        <Tooltip title="历史会话" placement="left"><button type="button" aria-label="历史会话"
          ref={historyButtonRef} disabled={!sourceWorkspace} aria-pressed={conversationsOpen} onClick={() => conversationsOpen ? closeConversations() : void openConversations()}><UiIcon name="history" /></button></Tooltip>
        <Tooltip title="副本管理" placement="left"><button type="button" aria-label="副本管理" onClick={() => void openWorkspaceManager()}><UiIcon name="snapshot" /></button></Tooltip>
        {sourceWorkspace?.sourceTabId && <Tooltip title="返回原页面" placement="left"><button type="button" aria-label="返回原页面" disabled={busy}
          onClick={() => void returnToSource()}><UiIcon name="back" /></button></Tooltip>}
        <div className="side-tools-spacer" />
        <Tooltip title="复制用户 ID" placement="left"><button type="button" aria-label="复制用户 ID" onClick={() => void copyUserId()}><UiIcon name="userId" /></button></Tooltip>
        {isAdmin && <Tooltip title="运行日志" placement="left"><button type="button" aria-label="运行日志" onClick={() => void openLogs()}><UiIcon name="logs" /></button></Tooltip>}
      </nav>
      <Modal
        title={`必须更新UI需求助手至 v${availableUpdate?.version ?? ''}`}
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
