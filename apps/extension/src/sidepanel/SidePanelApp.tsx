import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Spin, Tooltip } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { storage } from 'wxt/utils/storage';
import {
  PROTOCOL_VERSION,
  assistantTurnRequestSchema,
  assistantTurnResponseSchema,
  sourceTurnRequestSchema,
  sourceTurnProgressSchema,
  sourceTurnResponseSchema,
  sourceWorkspaceCreatedSchema,
  sourceWorkspaceInfoSchema,
  type ClarificationOption,
  type AssistantTurnResponse,
  type ContentCommand,
  type ContentCommandResult,
  type PageSelection,
  type SourceWorkspaceInfo,
  type SourceTurnProgress,
  type StaticSnapshot
} from '@ui-agent/contracts';
import { onMessage, sendMessage } from '../messaging';
import {
  createPortableSnapshotPackage,
  parsePortableSnapshotPackage,
  portableSnapshotFilename,
  serializePortableSnapshotPackage
} from '../snapshot/portable-snapshot';
import { DEFAULT_AGENT_SERVICE_URL, getAgentServiceUrl } from '../service/agent-service-config';
import { agentServiceFetch } from '../service/agent-service-client';
import { readAssistantEventStream } from '../service/assistant-event-stream';

const MarkdownMessage = lazy(() => import('./MarkdownMessage').then(module => ({
  default: module.MarkdownMessage
})));

// Side Panel 文档关闭时 Chrome 会自动断开该 Port，Background 据此立即清理选区。
const editorClientId = crypto.randomUUID();
const editorPort = browser.runtime.connect({ name: `ui-agent-editor:${editorClientId}` });
// 保留 Port 引用，避免扩展重载或长时间空闲时被垃圾回收而提前触发 onDisconnect。
void editorPort;

interface ClarificationPrompt {
  clarificationId: string;
  options?: ClarificationOption[];
  allowFreeText: boolean;
}
interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  clarification?: ClarificationPrompt;
}
type ServiceStatus = 'checking' | 'connected' | 'unavailable';
interface ActiveWorkspace extends SourceWorkspaceInfo {
  tabId: number;
  sourceTabId?: number;
}
interface PersistedWorkspaceSession {
  workspace: SourceWorkspaceInfo;
  chat: ChatEntry[];
  editSessionId: string;
  sourceTabId?: number;
  pendingClarification?: ClarificationPrompt;
}
const sourceWorkspaceSessionItem = storage.defineItem<PersistedWorkspaceSession | null>(
  'local:sourceWorkspaceSession',
  { fallback: null }
);
type IconName = 'sparkle' | 'target' | 'edit' | 'snapshot' | 'undo' | 'redo' | 'reset' | 'download' | 'upload' | 'arrow' | 'back';

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
    back: <><path d="m10 7-5 5 5 5" /><path d="M5 12h14" /></>
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
  const [pendingClarification, setPendingClarification] = useState<ClarificationPrompt>();
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [streamingAnswerId, setStreamingAnswerId] = useState<string>();
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const composerRef = useRef<TextAreaRef>(null);
  const snapshotFileRef = useRef<HTMLInputElement>(null);
  const busy = snapshotBusy || assistantBusy;

  useEffect(() => {
    getAgentServiceUrl().then(async url => {
      setServiceUrl(url);
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const match = /\/workspaces\/([0-9a-f-]{36})\/preview/i.exec(tab?.url ?? '');
      if (!match || !tab?.id) return;
      try {
        const [response, persisted] = await Promise.all([
          fetchAgentService(`${url.replace(/\/$/, '')}/v1/workspaces/${match[1]}`),
          sourceWorkspaceSessionItem.getValue()
        ]);
        if (!response.ok) return;
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
        if (persisted?.workspace.workspaceId === workspace.workspaceId) {
          setChat(persisted.chat);
          setEditSessionId(persisted.editSessionId);
          setPendingClarification(persisted.pendingClarification);
        }
        await command({ type: 'bindEditorTab', tabId: tab.id, previewUrl: workspace.previewUrl });
      } catch { /* Keep the regular page mode when workspace restoration fails. */ }
    });
  }, []);
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
    if (!sourceWorkspace) return;
    const { tabId: _tabId, sourceTabId: _sourceTabId, ...workspace } = sourceWorkspace;
    void sourceWorkspaceSessionItem.setValue({
      workspace,
      chat,
      editSessionId,
      sourceTabId: sourceWorkspace.sourceTabId,
      pendingClarification
    });
  }, [sourceWorkspace, chat, editSessionId, pendingClarification]);
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

  const startSelection = async () => {
    try { await command({ type: 'startSelection' }); setSelecting(true); }
    catch (error) { fail(error); }
  };

  const submitText = async (
    text: string,
    replyToClarificationId?: string,
    clarificationOptionId?: string
  ) => {
    if (!text) return;
    const userEntry: ChatEntry = { id: crypto.randomUUID(), role: 'user', text };
    setChat(entries => [...entries, userEntry]);
    setInstruction('');
    if (replyToClarificationId) setPendingClarification(undefined);
    setAssistantBusy(true);
    try {
      const request = assistantTurnRequestSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        turnId: crypto.randomUUID(),
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
        setChat(entries => id
          ? entries.map(entry => entry.id === id ? { ...entry, text: finalAnswer } : entry)
          : [...entries, { id: crypto.randomUUID(), role: 'assistant', text: finalAnswer }]);
        return;
      }
      if (finalOutcome.kind === 'clarification') {
        const clarification = {
          clarificationId: finalOutcome.clarificationId,
          options: finalOutcome.options,
          allowFreeText: finalOutcome.allowFreeText
        };
        setPendingClarification(clarification);
        setChat(entries => [...entries, {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: finalOutcome.question,
          clarification
        }]);
        return;
      }
      if (!sourceWorkspace) throw new Error('需要先进入副本编辑，才能执行页面修改');
      setAssistantBusy(false);
      await runSourceTurn(
        finalOutcome.instruction,
        sourceWorkspace,
        finalOutcome.targetScope === 'selection' ? selection?.selected.sourceId : undefined
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
      await command({ type: 'reloadPreview' });
    } catch (error) { fail(error); }
    finally { setSnapshotBusy(false); }
  };

  const exportScreenshot = async () => { try { await command({ type: 'exportScreenshot' }); } catch (error) { fail(error); } };
  const returnToSource = async () => {
    if (!sourceWorkspace?.sourceTabId) return;
    try {
      await browser.tabs.update(sourceWorkspace.sourceTabId, { active: true });
    } catch {
      fail(new Error('原页面标签页已关闭'));
    }
  };
  const openWorkspaceManager = async () => {
    await browser.tabs.create({ url: browser.runtime.getURL('/workspace-manager.html') });
  };
  const runSourceTurn = async (
    text: string,
    workspace: ActiveWorkspace,
    sourceId?: string
  ) => {
    setSnapshotBusy(true);
    let progressTimer: number | undefined;
    try {
      const request = sourceTurnRequestSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        editSessionId,
        turnId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        instruction: text,
        sourceId
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
      const progressUrl = `${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${workspace.workspaceId}/turns/${request.turnId}/progress`;
      const refreshProgress = async () => {
        try {
          const progressResponse = await fetchAgentService(progressUrl, { cache: 'no-store' });
          if (!progressResponse.ok) return;
          setSourceProgress(sourceTurnProgressSchema.parse(await progressResponse.json()));
        } catch {
          // Progress is best-effort. The main Turn request remains authoritative.
        }
      };
      progressTimer = window.setInterval(() => { void refreshProgress(); }, 650);
      const response = await fetchAgentService(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces/${workspace.workspaceId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      });
      if (!response.ok) throw await serviceResponseError(response, '源码 Agent 返回');
      const outcome = sourceTurnResponseSchema.parse(await response.json());
      if (outcome.kind === 'clarification') {
        const clarification = {
          clarificationId: outcome.clarificationId ?? crypto.randomUUID(),
          options: outcome.options,
          allowFreeText: outcome.allowFreeText
        };
        setPendingClarification(clarification);
        setChat(entries => [...entries, {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: outcome.question,
          clarification
        }]);
        return;
      }
      if (outcome.kind === 'failed') throw new Error(`[${outcome.code}] ${outcome.message}`);
      setSourceWorkspace(current => current ? {
        ...current,
        revision: outcome.revision,
        canUndo: outcome.revision > 0,
        canRedo: false
      } : current);
      setChat(entries => [...entries, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: outcome.summary
      }]);
      await command({ type: 'reloadPreview' });
    } catch (error) {
      fail(error);
    } finally {
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      setSnapshotBusy(false);
      setSourceProgress(undefined);
    }
  };

  const openWorkspaceFromSnapshot = async (snapshot: StaticSnapshot, sourceTabId?: number) => {
    setSnapshotBusy(true);
    let loadingTabId: number | undefined;
    let previewReady = false;
    try {
      const loadingTab = await browser.tabs.create({
        url: browser.runtime.getURL('/workspace-loading.html'),
        active: false
      });
      loadingTabId = loadingTab.id;
      if (!loadingTabId) throw new Error('静态副本标签页创建失败');
      const response = await fetchAgentService(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot)
      });
      if (!response.ok) throw await serviceResponseError(response, '静态源码工作区服务返回');
      const created = sourceWorkspaceCreatedSchema.parse(await response.json());
      const persistedWorkspace: SourceWorkspaceInfo = {
        ...created,
        sourceUrl: snapshot.sourceUrl,
        revision: 0,
        canUndo: false,
        canRedo: false
      };
      await sourceWorkspaceSessionItem.setValue({
        workspace: persistedWorkspace,
        chat,
        editSessionId,
        sourceTabId
      });
      setPendingClarification(undefined);
      setInstruction('');
      setSelection(undefined);
      const tab = await browser.tabs.update(loadingTabId, { url: created.previewUrl, active: false });
      if (!tab?.id) throw new Error('静态副本标签页更新失败');
      previewReady = true;
      // This panel instance belongs to the source tab. Do not migrate its
      // editorClientId or workspace UI to the new preview tab. The preview
      // creates its own tab-scoped panel and restores the persisted session.
      await browser.tabs.update(tab.id, { active: true });
      setSnapshotBusy(false);
    } catch (error) {
      fail(error);
      if (loadingTabId && !previewReady) {
        void browser.tabs.remove(loadingTabId).catch(() => undefined);
      } else if (loadingTabId && previewReady) {
        // Workspace 已经成功创建时保留副本。切换过去后，新 Side Panel 会再次尝试绑定。
        void browser.tabs.update(loadingTabId, { active: true }).catch(() => undefined);
      }
      setSnapshotBusy(false);
    }
  };
  const createSourceWorkspace = async () => {
    setSnapshotBusy(true);
    try {
      const [sourceTab, captured] = await Promise.all([
        browser.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]),
        command({ type: 'capturePageSnapshot' })
      ]);
      if (!captured.snapshot) throw new Error('页面没有返回静态源码副本');
      await openWorkspaceFromSnapshot(captured.snapshot, sourceTab?.id);
    } catch (error) {
      fail(error);
      setSnapshotBusy(false);
    }
  };
  const exportPortableSnapshot = async () => {
    setExportConfirmOpen(false);
    setSnapshotBusy(true);
    try {
      const captured = await command({ type: 'capturePageSnapshot' });
      if (!captured.snapshot) throw new Error('页面没有返回可导出的静态快照');
      const portable = createPortableSnapshotPackage(captured.snapshot);
      const blob = new Blob([serializePortableSnapshotPackage(portable)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      try {
        await browser.downloads.download({
          url,
          filename: portableSnapshotFilename(captured.snapshot.title, captured.snapshot.capturedAt),
          saveAs: true
        });
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
      }
      setNotice('离线快照包已导出');
      setError(undefined);
    } catch (error) {
      fail(error);
    } finally {
      setSnapshotBusy(false);
    }
  };
  const importPortableSnapshot = async (file: File) => {
    setSnapshotBusy(true);
    try {
      const portable = parsePortableSnapshotPackage(await file.text());
      setEditSessionId(crypto.randomUUID());
      await openWorkspaceFromSnapshot(portable.snapshot);
    } catch (error) {
      fail(error);
      setSnapshotBusy(false);
    } finally {
      if (snapshotFileRef.current) snapshotFileRef.current.value = '';
    }
  };
  const fail = (error: unknown) => {
    setError(error instanceof Error ? error.message : '操作失败');
    setNotice(undefined);
  };
  const examples = ['把按钮文案改成“确定”', '在右侧增加一个筛选项', '点击按钮时展开下方内容'];

  return (
    <main className="panel">
      <section className="workspace">
        <div className="conversation-header">
          <span>{sourceWorkspace ? '静态副本' : '新建 UI 示意'}</span>
          <div className="conversation-meta">
            <Tooltip title="管理所有副本">
              <Button
                className="header-back"
                type="text"
                size="small"
                icon={<UiIcon name="snapshot" />}
                onClick={() => void openWorkspaceManager()}
              >
                副本
              </Button>
            </Tooltip>
            {sourceWorkspace?.sourceTabId && (
              <Tooltip title="切换回原页面">
                <Button
                  className="header-back"
                  type="text"
                  size="small"
                  icon={<UiIcon name="back" />}
                  onClick={returnToSource}
                >
                  原页面
                </Button>
              </Tooltip>
            )}
            <Tooltip title={`Agent Service：${serviceUrl}`}>
              <span className={`service-status ${serviceStatus}`}><i />{serviceStatus === 'connected' ? '已连接' : serviceStatus === 'checking' ? '连接中' : '未连接'}</span>
            </Tooltip>
            <span className="demo-badge">DEMO</span>
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
              <p>确认后将在新标签页复制当前页面。进入副本后再选择区域、描述改动，原页面不会受到影响。</p>
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
              <p>展示的是可审计操作摘要，不包含模型的隐式推理内容。</p>
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
              <span>复制当前页面并在新标签页打开</span>
            </div>
            <div className="snapshot-transfer-actions">
              <Button type="text" icon={<UiIcon name="download" />} disabled={busy} onClick={() => setExportConfirmOpen(true)}>
                导出快照包
              </Button>
              <i />
              <Button type="text" icon={<UiIcon name="upload" />} disabled={busy} onClick={() => snapshotFileRef.current?.click()}>
                导入快照包
              </Button>
              <input
                ref={snapshotFileRef}
                className="snapshot-file-input"
                type="file"
                accept=".json,application/json"
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) void importPortableSnapshot(file);
                }}
              />
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
          </div>
        </footer>}
      </section>

      <Modal
        open={exportConfirmOpen}
        title="导出离线快照包"
        okText="确认并导出"
        cancelText="取消"
        onCancel={() => setExportConfirmOpen(false)}
        onOk={() => void exportPortableSnapshot()}
      >
        <p>快照包不包含脚本、接口、Cookie 或浏览器 Storage，但会包含页面当前可见文字和输入框中的值。</p>
        <p>请确认页面内容已经脱敏，并通过公司允许的方式传输文件。</p>
      </Modal>
    </main>
  );
}
