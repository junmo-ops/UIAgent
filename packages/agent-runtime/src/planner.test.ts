import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type StartTurnRequest } from '@ui-agent/contracts';
import { createAgentRuntime, DeepSeekPlanner, MockPlanner, type ConversationTurn, type Planner } from './index';

const request: StartTurnRequest = {
  protocolVersion: PROTOCOL_VERSION,
  editSessionId: 'session', turnId: 'turn', traceId: 'trace',
  instruction: '在它右侧增加一个筛选项，选项包括“全部”“待审核”“已通过”',
  context: {
    protocolVersion: PROTOCOL_VERSION, selectionVersion: 1, pageRevision: 0,
    page: { title: '订单', url: 'http://127.0.0.1:5173', viewportWidth: 1200, viewportHeight: 800 },
    selected: { id: 'selected', tag: 'button', text: '查询', rect: { x: 0, y: 0, width: 80, height: 32 } },
    selectedTree: { id: 'selected', tag: 'button', text: '查询', attributes: {}, children: [] },
    reusableTrees: [],
    parent: { tag: 'div', display: 'flex', flexDirection: 'row', gap: '8px' }, siblings: [], visibleStyle: {}, addedElements: [], addedTrees: []
  }
};

describe('MockPlanner', () => {
  it('creates a constrained select operation', async () => {
    const result = await new MockPlanner().plan(request);
    expect(result.kind).toBe('plan');
    if (result.kind === 'plan') {
      expect(result.plan.operations[0]).toMatchObject({ type: 'addComponent', anchor: { kind: 'node', nodeId: 'selected' }, component: 'select', position: 'after' });
      expect(result.plan.requiresConfirmation).toBe(false);
    }
  });

  it('requires confirmation for deletion', async () => {
    const result = await new MockPlanner().plan({ ...request, instruction: '删除这个元素' });
    expect(result.kind === 'plan' && result.plan.requiresConfirmation).toBe(true);
  });
});

describe('DeepSeekPlanner', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses DeepSeek JSON Object mode and validates the result locally', async () => {
    const result = {
      kind: 'plan',
      plan: {
        protocolVersion: PROTOCOL_VERSION,
        planId: 'plan-1',
        selectionVersion: 1,
        pageRevision: 0,
        summary: '新增刷新按钮',
        requiresConfirmation: false,
        operations: [{
          operationId: 'op-1', type: 'addComponent', anchor: { kind: 'node', nodeId: 'selected' },
          component: 'button', position: 'after', props: { text: '刷新' }
        }]
      }
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.model).toBe('deepseek-v4-flash');
      return new Response(JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion', created: 0, model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DeepSeekPlanner('https://api.deepseek.com', 'test-key', 'deepseek-v4-flash').plan(request))
      .resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.deepseek.com/chat/completions');
  });
});

describe('agent conversation memory', () => {
  it('passes previous turns to the planner in the same edit session', async () => {
    const observedHistory: ConversationTurn[][] = [];
    const clarification = {
      kind: 'clarification' as const,
      clarification: { protocolVersion: PROTOCOL_VERSION, reason: '缺少订单信息', question: '请提供订单详情' }
    };
    const planner: Planner = {
      async plan(_request, conversation = []) {
        observedHistory.push(conversation);
        return clarification;
      }
    };
    const runtime = createAgentRuntime(planner);

    await runtime.invoke({ ...request, turnId: 'turn-1', instruction: '新增一行订单' });
    await runtime.invoke({ ...request, turnId: 'turn-2', instruction: '随机生成就行' });

    expect(observedHistory[0]).toEqual([]);
    expect(observedHistory[1]).toEqual([{ instruction: '新增一行订单', result: clarification }]);
  });

  it('isolates conversations with different edit session ids', async () => {
    const observedLengths: number[] = [];
    const planner: Planner = {
      async plan(_request, conversation = []) {
        observedLengths.push(conversation.length);
        return { kind: 'clarification', clarification: { protocolVersion: PROTOCOL_VERSION, reason: 'test', question: 'test' } };
      }
    };
    const runtime = createAgentRuntime(planner);

    await runtime.invoke({ ...request, editSessionId: 'session-a', turnId: 'turn-a' });
    await runtime.invoke({ ...request, editSessionId: 'session-b', turnId: 'turn-b' });

    expect(observedLengths).toEqual([0, 0]);
  });
});
