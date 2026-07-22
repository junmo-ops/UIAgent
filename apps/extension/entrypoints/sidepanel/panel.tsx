import { useEffect, useState } from 'react';
import { Alert, Button, Card, Divider, Input, Modal, Space, Spin, Tag, Typography } from 'antd';
import { useMachine } from '@xstate/react';
import { storage } from 'wxt/utils/storage';
import {
  PROTOCOL_VERSION,
  plannerResultSchema,
  startTurnRequestSchema,
  type ChangePlan,
  type ContentCommand,
  type ContentCommandResult,
  type SelectedContext
} from '@ui-agent/contracts';
import { onMessage, sendMessage } from '../../src/messaging';
import { sessionMachine } from './session-machine';

const serviceUrlItem = storage.defineItem<string>('local:agentServiceUrl', { fallback: 'http://127.0.0.1:8787' });

// Side Panel 文档关闭时 Chrome 会自动断开该 Port，Background 据此立即清理选区。
const editorClientId = crypto.randomUUID();
browser.runtime.connect({ name: `ui-agent-editor:${editorClientId}` });

interface ChatEntry { id: string; role: 'user' | 'assistant'; text: string }

async function command(value: ContentCommand): Promise<Extract<ContentCommandResult, { ok: true }>> {
  const result = await sendMessage('browserCommand', { editorClientId, command: value });
  if (!result.ok) throw new Error(`[${result.code}] ${result.error}`);
  return result;
}

export function SidePanelApp() {
  const [state, send] = useMachine(sessionMachine);
  const [instruction, setInstruction] = useState('在它右侧增加一个筛选项，选项包括“全部”“待审核”“已通过”');
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [serviceUrl, setServiceUrl] = useState('http://127.0.0.1:8787');
  const [editSessionId, setEditSessionId] = useState(() => crypto.randomUUID());
  const busy = state.matches('planning') || state.matches('applying');

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
    setChat([]);
    send({ type: 'SELECTION_FOUND', selection: message.data });
  }), [send]);

  const startSelection = async () => {
    try { await command({ type: 'startSelection' }); send({ type: 'START_SELECTION' }); }
    catch (error) { fail(error); }
  };

  const refreshContext = async (): Promise<SelectedContext> => {
    const result = await command({ type: 'getContext' });
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
      const context = await refreshContext();
      const request = startTurnRequestSchema.parse({
        protocolVersion: PROTOCOL_VERSION, editSessionId,
        turnId: crypto.randomUUID(), traceId: crypto.randomUUID(), instruction: text, context
      });
      const response = await fetch(`${serviceUrl}/v1/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      if (!response.ok) throw new Error(`Agent Service 返回 ${response.status}`);
      const result = plannerResultSchema.parse(await response.json());
      if (result.kind === 'clarification') {
        const message = result.clarification.question;
        setChat(entries => [...entries, { id: crypto.randomUUID(), role: 'assistant', text: message }]);
        send({ type: 'CLARIFY', message }); return;
      }
      setChat(entries => [...entries, { id: crypto.randomUUID(), role: 'assistant', text: result.plan.summary }]);
      if (result.plan.requiresConfirmation) send({ type: 'NEEDS_CONFIRMATION', plan: result.plan });
      else await apply(result.plan, false);
    } catch (error) { fail(error); }
  };

  const apply = async (plan: ChangePlan, confirmed: boolean) => {
    send({ type: 'BEGIN_APPLY', plan });
    try {
      const result = await command({ type: 'applyPlan', plan, confirmedExistingRemoval: confirmed });
      const context = await refreshContext().catch(() => state.context.selection);
      send({ type: 'APPLIED', message: '页面示意已更新', selection: context, canUndo: result.canUndo ?? true, canRedo: result.canRedo ?? false });
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

  return (
    <main className="panel">
      <div className="panel-header"><div><Typography.Title level={4}>UI 需求示意助手</Typography.Title><Typography.Text type="secondary">选择页面元素，然后描述想要的改动</Typography.Text></div><Tag color="blue">Demo</Tag></div>
      <Card size="small" className="selection-card">
        {state.context.selection ? <Space direction="vertical" size={2}><Typography.Text strong>当前选区</Typography.Text><Typography.Text>{state.context.selection.selected.tag} · {state.context.selection.selected.text || '无文本'}</Typography.Text><Typography.Text type="secondary">版本 {state.context.selection.selectionVersion} / 页面 {state.context.selection.pageRevision}</Typography.Text></Space> : <Typography.Text type="secondary">尚未选择页面区域</Typography.Text>}
        <Button block type={state.matches('selecting') ? 'primary' : 'default'} onClick={startSelection} className="select-button">{state.matches('selecting') ? '请在页面中点击元素…' : '重新选择页面元素'}</Button>
      </Card>

      <section className="chat-list">
        {chat.length === 0 && <div className="empty-tip">示例：在它右侧添加一个筛选项，包含“全部”“待审核”“已通过”</div>}
        {chat.map(entry => <div key={entry.id} className={`bubble ${entry.role}`}>{entry.text}</div>)}
        {busy && <div className="bubble assistant"><Spin size="small" /> 正在生成受控修改方案…</div>}
      </section>

      {state.context.message && <Alert type="info" showIcon message={state.context.message} closable />}
      {state.context.error && <Alert type="error" showIcon message={state.context.error} closable onClose={() => send({ type: 'DISMISS' })} />}

      <div className="composer"><Input.TextArea value={instruction} onChange={event => setInstruction(event.target.value)} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="描述要添加、修改或删除的 UI…" onPressEnter={event => { if (!event.shiftKey) { event.preventDefault(); void submit(); } }} /><Button type="primary" disabled={!state.context.selection || busy || !instruction.trim()} loading={busy} onClick={submit}>生成示意</Button></div>
      <Divider />
      <Space wrap>
        <Button disabled={!state.context.canUndo || busy} onClick={() => history('undo')}>撤销</Button>
        <Button disabled={!state.context.canRedo || busy} onClick={() => history('redo')}>重做</Button>
        <Button disabled={!state.context.canUndo || busy} onClick={() => history('reset')}>恢复初始</Button>
        <Button disabled={busy} onClick={exportScreenshot}>导出截图</Button>
      </Space>
      <div className="service-url">Agent Service：{serviceUrl}</div>

      <Modal open={state.matches('confirming')} title="确认删除页面已有元素" okText="确认删除" okButtonProps={{ danger: true }} cancelText="取消" onCancel={() => send({ type: 'DISMISS' })} onOk={() => state.context.pendingPlan && apply(state.context.pendingPlan, true)}>
        <p>拟删除：<strong>{state.context.selection?.selected.text || state.context.selection?.selected.tag}</strong></p>
        <p>该操作只影响当前页面会话，之后仍可撤销。</p>
      </Modal>
    </main>
  );
}
