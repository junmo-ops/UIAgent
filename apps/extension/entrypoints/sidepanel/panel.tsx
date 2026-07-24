import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Spin, Tooltip } from 'antd';
import { useMachine } from '@xstate/react';
import { storage } from 'wxt/utils/storage';
import {
  PROTOCOL_VERSION,
  agentTurnResponseSchema,
  executionSubmissionSchema,
  startTurnRequestSchema,
  type AgentTurnResponse,
  type ChangePlan,
  type ContentCommand,
  type ContentCommandResult,
  type ContextScope,
  type SelectedContext
} from '@ui-agent/contracts';
import { onMessage, sendMessage } from '../../src/messaging';
import { sessionMachine } from './session-machine';

const serviceUrlItem = storage.defineItem<string>('local:agentServiceUrl', { fallback: 'http://127.0.0.1:8787' });

// Side Panel 文档关闭时 Chrome 会自动断开该 Port，Background 据此立即清理选区。
const editorClientId = crypto.randomUUID();
browser.runtime.connect({ name: `ui-agent-editor:${editorClientId}` });

interface ChatEntry { id: string; role: 'user' | 'assistant'; text: string }
interface ActiveTurn { turnId: string; traceId: string }
type IconName = 'sparkle' | 'target' | 'edit' | 'undo' | 'redo' | 'reset' | 'download' | 'arrow';

function UiIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    sparkle: <><path d="M12 2.8c.5 4.6 2.6 6.7 7.2 7.2-4.6.5-6.7 2.6-7.2 7.2-.5-4.6-2.6-6.7-7.2-7.2 4.6-.5 6.7-2.6 7.2-7.2Z" /><path d="M18.5 16.5c.2 1.8 1 2.6 2.7 2.8-1.7.2-2.5 1-2.7 2.7-.2-1.7-1-2.5-2.7-2.7 1.7-.2 2.5-1 2.7-2.8Z" /></>,
    target: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
    edit: <><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
    undo: <><path d="m9 7-5 5 5 5" /><path d="M5 12h8a6 6 0 0 1 6 6" /></>,
    redo: <><path d="m15 7 5 5-5 5" /><path d="M19 12h-8a6 6 0 0 0-6 6" /></>,
    reset: <><path d="M4.8 8A8 8 0 1 1 4 15" /><path d="M4 4v5h5" /></>,
    download: <><path d="M12 3v12" /><path d="m7.5 11 4.5 4.5 4.5-4.5" /><path d="M5 21h14" /></>,
    arrow: <><path d="M12 19V5" /><path d="m6.5 10.5 5.5-5.5 5.5 5.5" /></>
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

async function command(value: ContentCommand): Promise<Extract<ContentCommandResult, { ok: true }>> {
  const result = await sendMessage('browserCommand', { editorClientId, command: value });
  if (!result.ok) throw new Error(`[${result.code}] ${result.error}`);
  return result;
}

export function SidePanelApp() {
  const [state, send] = useMachine(sessionMachine);
  const [instruction, setInstruction] = useState('');
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [serviceUrl, setServiceUrl] = useState('http://127.0.0.1:8787');
  const [editSessionId, setEditSessionId] = useState(() => crypto.randomUUID());
  const [activeTurn, setActiveTurn] = useState<ActiveTurn>();
  const busy = state.matches('planning') || state.matches('applying') || state.matches('verifying') || state.matches('repairing');

  useEffect(() => { serviceUrlItem.getValue().then(setServiceUrl); }, []);
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
    setEditSessionId(crypto.randomUUID());
    setActiveTurn(undefined);
    setChat([]);
    send({ type: 'SELECTION_FOUND', selection: message.data });
  }), [send]);

  const startSelection = async () => {
    try { await command({ type: 'startSelection' }); send({ type: 'START_SELECTION' }); }
    catch (error) { fail(error); }
  };

  const refreshContext = async (scopes?: ContextScope[]): Promise<SelectedContext> => {
    const result = await command({ type: 'getContext', scopes });
    if (!result.context) throw new Error('页面没有返回选区上下文');
    send({ type: 'HISTORY', canUndo: result.canUndo ?? false, canRedo: result.canRedo ?? false, selection: result.context });
    return result.context;
  };

  const submit = async () => {
    const text = instruction.trim();
    if (!text) return;
    setChat(entries => [...entries, { id: crypto.randomUUID(), role: 'user', text }]);
    setInstruction(''); send({ type: 'SUBMIT' });
    try {
      const turn = { turnId: crypto.randomUUID(), traceId: crypto.randomUUID() };
      let scopes: ContextScope[] = [];
      let context = await refreshContext(scopes);
      let result: AgentTurnResponse;
      while (true) {
        const request = startTurnRequestSchema.parse({
          protocolVersion: PROTOCOL_VERSION, editSessionId,
          ...turn, instruction: text, context
        });
        const response = await fetch(`${serviceUrl}/v1/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request)
        });
        if (!response.ok) throw new Error(`Agent Service 返回 ${response.status}`);
        result = agentTurnResponseSchema.parse(await response.json());
        if (result.kind !== 'contextRequest') break;
        scopes = [...new Set([...scopes, ...result.contextRequest.scopes])];
        context = await refreshContext(scopes);
      }
      if (result.kind === 'clarification') {
        const message = result.clarification.question;
        setChat(entries => [...entries, { id: crypto.randomUUID(), role: 'assistant', text: message }]);
        send({ type: 'CLARIFY', message }); return;
      }
      if (result.kind !== 'execution') throw new Error(result.kind === 'failed' ? result.message : 'Agent 没有返回可执行计划');
      setActiveTurn(turn);
      setChat(entries => [...entries, { id: crypto.randomUUID(), role: 'assistant', text: result.plan.summary }]);
      if (result.plan.requiresConfirmation) send({ type: 'NEEDS_CONFIRMATION', plan: result.plan });
      else await apply(result.plan, false, turn);
    } catch (error) { fail(error); }
  };

  const apply = async (plan: ChangePlan, confirmed: boolean, turn: ActiveTurn | undefined = activeTurn) => {
    send({ type: 'BEGIN_APPLY', plan });
    try {
      if (!turn) throw new Error('当前 Agent Turn 已失效，请重新提交指令');
      const result = await command({ type: 'applyPlan', plan, confirmedExistingRemoval: confirmed });
      if (!result.receipt) throw new Error('页面没有返回执行回执');
      const context = await refreshContext();
      send({ type: 'BEGIN_VERIFY' });
      const submission = executionSubmissionSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        editSessionId,
        ...turn,
        planId: plan.planId,
        beforePageRevision: plan.pageRevision,
        receipt: result.receipt,
        observation: context
      });
      const response = await fetch(`${serviceUrl}/v1/turns/${turn.turnId}/execution`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission)
      });
      if (!response.ok) throw new Error(`Agent Service 验证接口返回 ${response.status}`);
      const outcome = agentTurnResponseSchema.parse(await response.json());
      if (outcome.kind === 'completed') {
        setChat(entries => [...entries, { id: crypto.randomUUID(), role: 'assistant', text: outcome.verification.summary }]);
        setActiveTurn(undefined);
        send({ type: 'APPLIED', message: '页面示意已更新并通过执行后验证', selection: context, canUndo: result.canUndo ?? true, canRedo: result.canRedo ?? false });
        return;
      }
      if (outcome.kind === 'execution') {
        setChat(entries => [...entries, { id: crypto.randomUUID(), role: 'assistant', text: `检查发现执行结果需要修正：${outcome.verification?.summary ?? '执行未达到预期'}。正在进行一次安全修正。` }]);
        send({ type: 'BEGIN_REPAIR' });
        if (outcome.plan.requiresConfirmation) send({ type: 'NEEDS_CONFIRMATION', plan: outcome.plan });
        else await apply(outcome.plan, false, turn);
        return;
      }
      if (outcome.kind === 'clarification') {
        setChat(entries => [...entries, { id: crypto.randomUUID(), role: 'assistant', text: outcome.clarification.question }]);
        send({ type: 'CLARIFY', message: outcome.clarification.question });
        return;
      }
      if (outcome.kind === 'contextRequest') {
        throw new Error(`执行后修正需要补充页面上下文：${outcome.contextRequest.reason}`);
      }
      throw new Error(`[${outcome.code}] ${outcome.message}`);
    } catch (error) { fail(error); }
  };

  const history = async (type: 'undo' | 'redo' | 'reset') => {
    try {
      const result = await command({ type });
      const context = await refreshContext().catch(() => state.context.selection);
      send({ type: 'HISTORY', canUndo: result.canUndo ?? false, canRedo: result.canRedo ?? false, selection: context });
    } catch (error) { fail(error); }
  };

  const exportScreenshot = async () => { try { await command({ type: 'exportScreenshot' }); } catch (error) { fail(error); } };
  const fail = (error: unknown) => send({ type: 'FAIL', error: error instanceof Error ? error.message : '操作失败' });
  const selection = state.context.selection;
  const examples = ['把按钮文案改成“确定”', '在右侧增加一个筛选项'];

  return (
    <main className="panel">
      <header className="panel-header">
        <div className="brand">
          <span className="brand-mark"><UiIcon name="sparkle" /></span>
          <div>
            <div className="brand-title">UI 示意助手</div>
            <div className="brand-subtitle">用对话快速表达页面改动</div>
          </div>
        </div>
        <Tooltip title={`Agent Service：${serviceUrl}`}>
          <span className="service-status"><i />已连接</span>
        </Tooltip>
      </header>

      <section className="workspace">
        <div className="conversation-header">
          <span>新建 UI 示意</span>
          <span className="demo-badge">DEMO</span>
        </div>

        <div className={`selection-strip ${selection ? 'has-selection' : ''}`}>
          <span className="selection-symbol"><UiIcon name="target" /></span>
          <div className="selection-copy">
            <span className="selection-label">{selection ? '当前选区' : '还没有选择区域'}</span>
            <span className="selection-value">
              {selection ? `${selection.selected.tag} · ${selection.selected.text || '无文本内容'}` : '先在页面中选择需要调整的元素'}
            </span>
          </div>
          <Button
            type="text"
            className="selection-action"
            icon={<UiIcon name="edit" />}
            onClick={startSelection}
          >
            {state.matches('selecting') ? '选择中…' : selection ? '重选' : '选择'}
          </Button>
        </div>

        <section className="chat-list">
          {chat.length === 0 && (
            <div className="empty-tip">
              <span className="empty-icon"><UiIcon name="sparkle" /></span>
              <strong>描述你想看到的页面效果</strong>
              <p>选中页面元素后，可以修改内容、样式、布局，或添加新的基础组件。</p>
              <div className="example-list">
                {examples.map(example => <button key={example} type="button" onClick={() => setInstruction(example)}>{example}</button>)}
              </div>
            </div>
          )}
          {chat.map(entry => <div key={entry.id} className={`bubble ${entry.role}`}>{entry.text}</div>)}
          {busy && (
            <div className="bubble assistant working">
              <Spin size="small" />
              <span>{state.matches('verifying') ? '正在验证页面结果…' : state.matches('repairing') ? '正在生成安全修正…' : state.matches('applying') ? '正在更新页面示意…' : '正在理解并生成方案…'}</span>
            </div>
          )}
          {state.context.message && <Alert className="inline-alert" type="info" showIcon message={state.context.message} closable />}
          {state.context.error && <Alert className="inline-alert" type="error" showIcon message={state.context.error} closable onClose={() => send({ type: 'DISMISS' })} />}
        </section>

        <footer className="composer-shell">
          <Input.TextArea
            value={instruction}
            variant="borderless"
            onChange={event => setInstruction(event.target.value)}
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder={selection ? '描述你想怎样修改这个区域…' : '请先选择一个页面区域'}
            onPressEnter={event => { if (!event.shiftKey) { event.preventDefault(); void submit(); } }}
          />
          <div className="composer-toolbar">
            <div className="history-actions">
              <Tooltip title="撤销"><Button type="text" shape="circle" aria-label="撤销" disabled={!state.context.canUndo || busy} icon={<UiIcon name="undo" />} onClick={() => history('undo')} /></Tooltip>
              <Tooltip title="重做"><Button type="text" shape="circle" aria-label="重做" disabled={!state.context.canRedo || busy} icon={<UiIcon name="redo" />} onClick={() => history('redo')} /></Tooltip>
              <Tooltip title="恢复初始"><Button type="text" shape="circle" aria-label="恢复初始" disabled={!state.context.canUndo || busy} icon={<UiIcon name="reset" />} onClick={() => history('reset')} /></Tooltip>
              <span className="toolbar-divider" />
              <Tooltip title="导出当前可视区域"><Button type="text" shape="circle" aria-label="导出截图" disabled={busy} icon={<UiIcon name="download" />} onClick={exportScreenshot} /></Tooltip>
            </div>
            <Tooltip title={!selection ? '请先选择页面区域' : '生成示意'}>
              <Button
                className="send-button"
                type="primary"
                shape="circle"
                aria-label="生成示意"
                disabled={!selection || busy || !instruction.trim()}
                loading={busy}
                icon={!busy && <UiIcon name="arrow" />}
                onClick={submit}
              />
            </Tooltip>
          </div>
        </footer>
      </section>

      <Modal open={state.matches('confirming')} title="确认删除页面已有元素" okText="确认删除" okButtonProps={{ danger: true }} cancelText="取消" onCancel={() => send({ type: 'DISMISS' })} onOk={() => state.context.pendingPlan && apply(state.context.pendingPlan, true)}>
        <p>拟删除：<strong>{selection?.selected.text || selection?.selected.tag}</strong></p>
        <p>该操作只影响当前页面会话，之后仍可撤销。</p>
      </Modal>
    </main>
  );
}
