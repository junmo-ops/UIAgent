import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type StartTurnRequest } from '@ui-agent/contracts';
import { validatePlan } from '@ui-agent/domain';
import {
  compilePlannerResult,
  createAgentRuntime,
  DeepSeekPlanner,
  MockPlanner,
  type ConversationTurn,
  type Planner,
  type RuntimeTraceEvent
} from './index';

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
    const traces: RuntimeTraceEvent[] = [];
    const result = {
      kind: 'plan',
      plan: {
        protocolVersion: PROTOCOL_VERSION,
        planId: 'plan-1',
        selectionVersion: 1,
        pageRevision: 0,
        summary: '新增刷新按钮',
        intent: {
          summary: '新增刷新按钮',
          goals: [{
            goalId: 'refresh-goal', action: 'create', role: 'button', resultRef: 'refresh',
            content: { text: '刷新' },
            placement: {
              anchor: { kind: 'node', nodeId: 'selected' },
              relation: 'after', strict: true, sameRow: false
            },
            preserveTexts: []
          }]
        },
        requiresConfirmation: false,
        operations: [{
          operationId: 'op-1', type: 'addComponent', anchor: { kind: 'node', nodeId: 'selected' },
          component: 'button', position: 'after', resultRef: 'refresh', props: { text: '刷新' }
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

    await expect(new DeepSeekPlanner(
      'https://api.deepseek.com',
      'test-key',
      'deepseek-v4-flash',
      event => traces.push(event)
    ).plan(request))
      .resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.deepseek.com/chat/completions');
    expect(traces).toEqual([expect.objectContaining({
      type: 'model.attempt.completed',
      attempt: 1,
      promptChars: expect.any(Number),
      systemChars: expect.any(Number)
    })]);
  });

  it('retries once when AI SDK reports an empty structured output', async () => {
    const traces: RuntimeTraceEvent[] = [];
    const validResult = {
      kind: 'plan',
      plan: {
        protocolVersion: PROTOCOL_VERSION,
        planId: 'plan-after-empty-output',
        selectionVersion: 1,
        pageRevision: 0,
        summary: '新增两个筛选项',
        intent: {
          summary: '新增两个筛选项',
          goals: [{
            goalId: 'source-filter',
            action: 'create',
            role: 'select',
            resultRef: 'source',
            content: { label: '订单来源' },
            placement: {
              anchor: { kind: 'node', nodeId: 'selected' },
              relation: 'after',
              strict: true,
              sameRow: true
            },
            preserveTexts: []
          }]
        },
        requiresConfirmation: false,
        operations: [{
          operationId: 'add-source',
          type: 'addComponent',
          anchor: { kind: 'node', nodeId: 'selected' },
          component: 'select',
          position: 'after',
          resultRef: 'source',
          props: { label: '订单来源' }
        }]
      }
    };
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body));
      expect(body.max_tokens).toBe(4096);
      const content = callCount === 1 ? '' : JSON.stringify(validResult);
      return new Response(JSON.stringify({
        id: `chatcmpl-${callCount}`,
        object: 'chat.completion',
        created: 0,
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: callCount === 1 ? 'length' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DeepSeekPlanner(
      'https://api.deepseek.com',
      'test-key',
      'deepseek-v4-flash',
      event => traces.push(event)
    ).plan(request)).resolves.toMatchObject(validResult);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(traces).toEqual([
      expect.objectContaining({ type: 'model.attempt.failed', attempt: 1, error: 'No output generated.' }),
      expect.objectContaining({
        type: 'model.attempt.completed',
        attempt: 2,
        repairReason: expect.stringContaining('没有生成可解析的输出')
      })
    ]);
  });
});

describe('model node reference normalization', () => {
  const fullAnchorId = 'el-9cb3bba2-623f-4d86-a86e-90e54ec233f0';
  const fullSourceId = 'el-686cb5f8-2022-48d6-8d0e-4fbdee2f363a';

  const referenceRequest: StartTurnRequest = {
    ...request,
    context: {
      ...request.context,
      selected: { ...request.context.selected, id: 'selected-cell', tag: 'td', text: '详情 编辑' },
      selectedTree: {
        id: 'selected-cell',
        tag: 'td',
        text: '',
        attributes: {},
        children: [{
          id: fullAnchorId,
          tag: 'div',
          text: '',
          attributes: {},
          children: [{
            id: fullSourceId,
            tag: 'a',
            text: '编辑',
            attributes: {},
            children: []
          }]
        }]
      },
      elementIndex: [
        { id: fullAnchorId, tag: 'div', text: '' },
        { id: fullSourceId, tag: 'a', text: '编辑' }
      ]
    }
  };

  it('resolves a unique model-truncated node ID before intent compilation', () => {
    const modelResult = {
      kind: 'plan' as const,
      plan: {
        protocolVersion: PROTOCOL_VERSION,
        planId: 'truncated-node-plan',
        selectionVersion: 1,
        pageRevision: 0,
        summary: '在编辑右边增加删除',
        requiresConfirmation: false,
        intent: {
          summary: '在编辑右边增加删除',
          goals: [{
            goalId: 'create-delete',
            action: 'create' as const,
            role: 'link' as const,
            resultRef: 'delete-link',
            content: { text: '删除' },
            placement: {
              anchor: { kind: 'node' as const, nodeId: 'el-9cb3bba2' },
              relation: 'after' as const,
              strict: true,
              sameRow: true
            },
            appearance: {
              mode: 'match' as const,
              source: { kind: 'node' as const, nodeId: 'el-686cb5f8' }
            },
            preserveTexts: []
          }]
        },
        operations: [{
          operationId: 'add-delete',
          type: 'addComponent' as const,
          anchor: { kind: 'node' as const, nodeId: 'el-9cb3bba2' },
          component: 'link' as const,
          position: 'after' as const,
          resultRef: 'delete-link',
          props: { text: '删除' }
        }, {
          operationId: 'fragile-content',
          type: 'updateContent' as const,
          target: { kind: 'result' as const, resultRef: 'delete-link', path: [0] },
          text: '删除'
        }, {
          operationId: 'fragile-appearance',
          type: 'copyStyles' as const,
          source: { kind: 'node' as const, nodeId: 'el-686cb5f8' },
          target: { kind: 'result' as const, resultRef: 'delete-link', path: [0] }
        }]
      }
    };

    const normalized = compilePlannerResult(referenceRequest, modelResult);
    expect(normalized).toMatchObject({
      kind: 'plan',
      plan: {
        operations: [
          { type: 'addComponent', anchor: { kind: 'node', nodeId: fullAnchorId } },
          { type: 'copyStyles', source: { kind: 'node', nodeId: fullSourceId } }
        ]
      }
    });
    if (normalized.kind === 'plan') {
      expect(normalized.plan.operations).toHaveLength(2);
      expect(() => validatePlan(normalized.plan, referenceRequest.context)).not.toThrow();
    }
  });

  it('rejects an ambiguous truncated node ID instead of widening permissions', () => {
    const ambiguousRequest: StartTurnRequest = {
      ...referenceRequest,
      context: {
        ...referenceRequest.context,
        elementIndex: [
          ...(referenceRequest.context.elementIndex ?? []),
          { id: 'el-9cb3bba2-other-node', tag: 'div', text: '另一个元素' }
        ]
      }
    };
    const modelResult = {
      kind: 'contextRequest' as const,
      contextRequest: {
        protocolVersion: PROTOCOL_VERSION,
        reason: '读取目标样式',
        scopes: ['visibleStyles' as const],
        targetNodeIds: ['el-9cb3bba2']
      }
    };

    expect(() => compilePlannerResult(ambiguousRequest, modelResult)).toThrow(/匹配到多个局部元素/);
  });
});

describe('intent-driven plan compilation', () => {
  it('compiles appearance matching into a controlled style copy instead of model-authored CSS', () => {
    const appearanceRequest: StartTurnRequest = {
      ...request,
      context: {
        ...request.context,
        elementIndex: [
          { id: 'edit-link', tag: 'a', text: '编辑' },
          { id: 'delete-button', tag: 'button', text: '删除', isSessionAdded: true }
        ]
      }
    };
    const modelResult = {
      kind: 'plan' as const,
      plan: {
        protocolVersion: PROTOCOL_VERSION,
        planId: 'appearance-plan',
        selectionVersion: 1,
        pageRevision: 0,
        summary: '删除按钮匹配编辑外观',
        requiresConfirmation: false,
        intent: {
          summary: '删除按钮匹配编辑外观',
          goals: [{
            goalId: 'match-appearance',
            action: 'update' as const,
            role: 'button' as const,
            target: { kind: 'node' as const, nodeId: 'delete-button' },
            content: {},
            appearance: {
              mode: 'match' as const,
              source: { kind: 'node' as const, nodeId: 'edit-link' }
            },
            preserveTexts: []
          }]
        },
        operations: [{
          operationId: 'guessed-css',
          type: 'updateStyle' as const,
          target: { kind: 'node' as const, nodeId: 'delete-button' },
          styles: { cursor: 'pointer', background: 'transparent' }
        }]
      }
    };

    const normalized = compilePlannerResult(appearanceRequest, modelResult);
    expect(normalized).toMatchObject({
      kind: 'plan',
      plan: {
        operations: [{
          type: 'copyStyles',
          source: { kind: 'node', nodeId: 'edit-link' },
          target: { kind: 'node', nodeId: 'delete-button' }
        }]
      }
    });
  });

  it('compiles a semantic goal into a controlled component capability', () => {
    const formRequest: StartTurnRequest = {
      ...request,
      instruction: '在订单渠道后增加付款方式，选项为月结、预付、货到付款',
      context: {
        ...request.context,
        selected: { ...request.context.selected, id: 'form-row', tag: 'div', text: '订单渠道 请选择渠道' },
        selectedTree: {
          id: 'form-row', tag: 'div', text: '', attributes: {}, children: [{
            id: 'channel-field', tag: 'div', text: '', attributes: { 'data-ui-component': 'form-field-select' },
            children: [{ id: 'framework-internal', tag: 'div', text: '订单渠道 请选择渠道', attributes: {}, children: [] }]
          }]
        }
      }
    };
    const modelResult = {
      kind: 'plan' as const,
      plan: {
        protocolVersion: PROTOCOL_VERSION, planId: 'form-plan', selectionVersion: 1, pageRevision: 0,
        summary: '新增付款方式', requiresConfirmation: false,
        intent: {
          summary: '新增付款方式',
          goals: [{
            goalId: 'payment-goal', action: 'create' as const, role: 'select' as const,
            resultRef: 'payment',
            content: { label: '付款方式', options: ['月结', '预付', '货到付款'] },
            placement: {
              anchor: { kind: 'node' as const, nodeId: 'channel-field' },
              relation: 'after' as const, strict: true, sameRow: false
            },
            preserveTexts: []
          }]
        },
        operations: [
          { operationId: 'clone', type: 'cloneSubtree' as const, source: { kind: 'node' as const, nodeId: 'channel-field' }, anchor: { kind: 'node' as const, nodeId: 'channel-field' }, position: 'after' as const, resultRef: 'payment' }
        ]
      }
    };

    const normalized = compilePlannerResult(formRequest, modelResult);
    expect(normalized.kind).toBe('plan');
    if (normalized.kind === 'plan') {
      expect(normalized.plan.operations).toEqual([expect.objectContaining({
        type: 'addComponent', component: 'select', resultRef: 'payment',
        props: { label: '付款方式', placeholder: '请选择付款方式', options: ['月结', '预付', '货到付款'] }
      })]);
    }
  });

  it('uses declared goal semantics instead of instruction keyword rewriting', () => {
    const semanticRequest: StartTurnRequest = {
      ...request,
      instruction: '增加黄色提示“需要补充合同”、红色标签“高风险”和批量驳回危险按钮',
    };
    const modelResult = {
      kind: 'plan' as const,
      plan: {
        protocolVersion: PROTOCOL_VERSION, planId: 'semantic-plan', selectionVersion: 1, pageRevision: 0,
        summary: '新增语义组件', requiresConfirmation: false,
        intent: {
          summary: '新增语义组件',
          goals: [
            {
              goalId: 'warning-goal', action: 'create' as const, role: 'alert' as const,
              resultRef: 'warning', content: { text: '需要补充合同', variant: 'warning' as const },
              placement: { anchor: { kind: 'node' as const, nodeId: 'selected' }, relation: 'after' as const, strict: true, sameRow: false },
              preserveTexts: []
            },
            {
              goalId: 'risk-goal', action: 'create' as const, role: 'tag' as const,
              resultRef: 'risk', content: { text: '高风险', variant: 'danger' as const },
              placement: { anchor: { kind: 'node' as const, nodeId: 'selected' }, relation: 'after' as const, strict: true, sameRow: false },
              preserveTexts: []
            },
            {
              goalId: 'reject-goal', action: 'create' as const, role: 'button' as const,
              resultRef: 'reject', content: { text: '批量驳回', variant: 'danger' as const },
              placement: { anchor: { kind: 'node' as const, nodeId: 'selected' }, relation: 'after' as const, strict: true, sameRow: false },
              preserveTexts: []
            }
          ]
        },
        operations: [
          {
            operationId: 'alert', type: 'addComponent' as const,
            anchor: { kind: 'node' as const, nodeId: 'selected' }, component: 'text' as const,
            position: 'after' as const, resultRef: 'warning', props: { text: '需要补充合同' }
          },
          {
            operationId: 'tag', type: 'addComponent' as const,
            anchor: { kind: 'node' as const, nodeId: 'selected' }, component: 'text' as const,
            position: 'after' as const, resultRef: 'risk', props: { text: '高风险' }
          },
          {
            operationId: 'danger', type: 'addComponent' as const,
            anchor: { kind: 'node' as const, nodeId: 'selected' }, component: 'button' as const,
            position: 'after' as const, resultRef: 'reject', props: { text: '批量驳回' }
          }
        ]
      }
    };

    const normalized = compilePlannerResult(semanticRequest, modelResult);
    expect(normalized.kind).toBe('plan');
    if (normalized.kind === 'plan') {
      expect(normalized.plan.operations[0]).toMatchObject({
        type: 'addComponent', component: 'alert', props: { text: '需要补充合同', variant: 'warning' }
      });
      expect(normalized.plan.operations[1]).toMatchObject({
        type: 'addComponent', component: 'tag', props: { text: '高风险', variant: 'danger' }
      });
      expect(normalized.plan.operations[2]).toMatchObject({
        type: 'addComponent', component: 'button', props: { text: '批量驳回', variant: 'danger' }
      });
    }
  });
});

describe('agent conversation memory', () => {
  it('does not persist internal context expansion as a user conversation turn', async () => {
    const observedLengths: number[] = [];
    let calls = 0;
    const planner: Planner = {
      async plan(_request, conversation = []) {
        observedLengths.push(conversation.length);
        calls += 1;
        return calls === 1
          ? {
              kind: 'contextRequest',
              contextRequest: {
                protocolVersion: PROTOCOL_VERSION,
                reason: '需要相邻元素',
                scopes: ['siblings']
              }
            }
          : {
              kind: 'clarification',
              clarification: { protocolVersion: PROTOCOL_VERSION, reason: 'test', question: 'test' }
            };
      }
    };
    const runtime = createAgentRuntime(planner);

    await runtime.invoke({ ...request, turnId: 'context-1' });
    await runtime.invoke({ ...request, turnId: 'context-2', context: { ...request.context, contextScopes: ['siblings'] } });

    expect(observedLengths).toEqual([0, 0]);
  });

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
