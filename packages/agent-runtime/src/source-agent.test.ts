import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type SourceAgentDecision, type SourceTurnRequest } from '@ui-agent/contracts';
import { SourceEditingAgent, type SourceDecisionMaker, type SourceFileTools } from './source-agent';

class SequenceDecisions implements SourceDecisionMaker {
  constructor(private readonly values: SourceAgentDecision[]) {}
  async decide() {
    const value = this.values.shift();
    if (!value) throw new Error('decision sequence exhausted');
    return value;
  }
}

const request: SourceTurnRequest = {
  protocolVersion: PROTOCOL_VERSION,
  editSessionId: 'session',
  turnId: 'turn',
  traceId: 'trace',
  instruction: '把查询改成确定',
  sourceId: 'source-0'
};

function tools() {
  let content = '<button>查询</button>';
  let rolledBack = false;
  const value: SourceFileTools = {
    listFiles: async () => [{ path: 'index.html', chars: content.length }],
    searchText: async query => content.includes(query) ? `1: ${content}` : '没有找到',
    readFile: async () => content,
    inspectElement: async sourceId => `元素 ${sourceId}\nvisibleText: "查询"\nrawTextSegments: ["查询"]`,
    readStyleRule: async className => `.${className}{color:red}`,
    replaceText: async (_path, search, replacement) => {
      if (!content.includes(search)) throw new Error('替换原文不匹配');
      content = content.replace(search, replacement);
      return '替换成功';
    },
    applyPatch: async () => 'Patch 成功',
    replaceInElement: async (_sourceId, search, replacement) => {
      if (!content.includes(search)) throw new Error('替换原文不在目标元素内');
      content = content.replace(search, replacement);
      return '元素内替换成功';
    },
    moveElement: async () => '元素移动成功',
    cloneElement: async () => '元素克隆成功',
    validate: async () => '校验通过',
    commit: async () => 1,
    rollback: async () => { rolledBack = true; }
  };
  return { value, content: () => content, rolledBack: () => rolledBack };
}

describe('SourceEditingAgent', () => {
  it('runs a bounded search, read, replace and finish loop', async () => {
    const fileTools = tools();
    const agent = new SourceEditingAgent(new SequenceDecisions([
      { action: 'search', query: '查询', reason: '定位按钮' },
      { action: 'read', path: 'index.html', startLine: 1, endLine: 20, reason: '读取结构' },
      { action: 'replace', path: 'index.html', search: '查询', replace: '确定', reason: '修改文案' },
      { action: 'finish', summary: '已修改按钮文案' }
    ]));
    await expect(agent.run(request, fileTools.value)).resolves.toMatchObject({
      kind: 'completed',
      revision: 1,
      modelCalls: 4,
      toolCalls: 4
    });
    expect(fileTools.content()).toContain('确定');
  });

  it('rolls back repeated no-progress decisions', async () => {
    const fileTools = tools();
    const repeated = { action: 'search', query: '不存在', reason: '定位' } as const;
    const agent = new SourceEditingAgent(new SequenceDecisions([repeated, repeated]));
    await expect(agent.run(request, fileTools.value)).resolves.toMatchObject({
      kind: 'failed',
      code: 'SOURCE_AGENT_ERROR'
    });
    expect(fileTools.rolledBack()).toBe(true);
  });

  it('passes recent workspace conversation into each model decision', async () => {
    const observed: string[] = [];
    const decider: SourceDecisionMaker = {
      async decide(input) {
        observed.push(...input.conversation.map(item => item.instruction));
        return { action: 'clarify', question: '请补充金额范围' };
      }
    };
    const agent = new SourceEditingAgent(decider);
    await agent.run(request, tools().value, [
      { instruction: '新增一行订单', result: '请提供订单信息' },
      { instruction: '随机生成', result: '已随机生成订单' }
    ]);
    expect(observed).toEqual(['新增一行订单', '随机生成']);
  });

  it('can continue beyond the previous five-model-call budget', async () => {
    const fileTools = tools();
    const agent = new SourceEditingAgent(new SequenceDecisions([
      { action: 'search', query: '按钮', reason: '先定位组件类型' },
      { action: 'search', query: '查询', reason: '定位按钮文案' },
      { action: 'read', path: 'index.html', startChar: 0, endChar: 30, reason: '读取按钮结构' },
      { action: 'search', query: '<button', reason: '确认标签起点' },
      { action: 'search', query: '</button>', reason: '确认标签终点' },
      { action: 'read', path: 'index.html', startLine: 1, endLine: 1, reason: '再次核对完整结构' },
      { action: 'replace', path: 'index.html', search: '查询', replace: '确定', reason: '修改文案' },
      { action: 'finish', summary: '已修改按钮文案' }
    ]));

    await expect(agent.run(request, fileTools.value)).resolves.toMatchObject({
      kind: 'completed',
      modelCalls: 8,
      toolCalls: 8
    });
  });

  it('uses selected-element inspection and scoped replacement for a simple text change', async () => {
    const fileTools = tools();
    const agent = new SourceEditingAgent(new SequenceDecisions([
      {
        action: 'replaceInElement',
        sourceId: 'source-0',
        search: '查询',
        replace: '确定',
        reason: '根据预检提供的原始文本修改选中按钮'
      },
      { action: 'finish', summary: '已修改按钮文案' }
    ]));

    await expect(agent.run(request, fileTools.value)).resolves.toMatchObject({
      kind: 'completed',
      modelCalls: 2,
      toolCalls: 2
    });
    expect(fileTools.content()).toBe('<button>确定</button>');
  });

  it('feeds a recoverable tool error back into the loop instead of failing the turn', async () => {
    const fileTools = tools();
    const observedResults: string[][] = [];
    const decisions: SourceAgentDecision[] = [
      {
        action: 'replaceInElement',
        sourceId: 'source-0',
        search: '不存在',
        replace: '确定',
        reason: '第一次替换使用了错误原文'
      },
      {
        action: 'replaceInElement',
        sourceId: 'source-0',
        search: '查询',
        replace: '确定',
        reason: '根据工具错误修正原文'
      },
      { action: 'finish', summary: '已修改按钮文案' }
    ];
    const agent = new SourceEditingAgent({
      async decide(input) {
        observedResults.push(input.observations.map(item => item.result));
        const decision = decisions.shift();
        if (!decision) throw new Error('decision sequence exhausted');
        return decision;
      }
    });

    await expect(agent.run(request, fileTools.value)).resolves.toMatchObject({
      kind: 'completed',
      modelCalls: 3
    });
    expect(observedResults[1]).toEqual(expect.arrayContaining([
      expect.stringContaining('TOOL_ERROR')
    ]));
  });

  it('uses the structured move tool instead of rebuilding an existing element', async () => {
    const fileTools = tools();
    const moves: string[] = [];
    fileTools.value.moveElement = async (sourceId, position, targetSourceId) => {
      moves.push([sourceId, position, targetSourceId].filter(Boolean).join(':'));
      return '元素已完整移动，原始结构和样式保持不变';
    };
    const agent = new SourceEditingAgent(new SequenceDecisions([
      {
        action: 'moveElement',
        sourceId: 'source-0',
        position: 'parentEnd',
        reason: '用户要求移动到当前布局区域底部'
      },
      { action: 'finish', summary: '已将所选元素移动到原父容器末尾' }
    ]));

    await expect(agent.run({
      ...request,
      instruction: '把这段移到页面底部'
    }, fileTools.value)).resolves.toMatchObject({
      kind: 'completed',
      modelCalls: 2,
      toolCalls: 2
    });
    expect(moves).toEqual(['source-0:parentEnd']);
  });

  it('uses the structured clone tool for a same-style element', async () => {
    const fileTools = tools();
    const clones: unknown[][] = [];
    fileTools.value.cloneElement = async (...args) => {
      clones.push(args);
      return '已完整克隆元素 source-10；内联样式和结构保持一致';
    };
    const agent = new SourceEditingAgent(new SequenceDecisions([
      {
        action: 'cloneElement',
        templateSourceId: 'source-0',
        position: 'parentEnd',
        replacements: [{ search: '查询', replace: '确定' }],
        reason: '新增一个与现有按钮样式一致的按钮'
      },
      { action: 'finish', summary: '已新增同款按钮' }
    ]));

    await expect(agent.run({
      ...request,
      instruction: '增加一个按钮，样式跟上面一致'
    }, fileTools.value)).resolves.toMatchObject({
      kind: 'completed',
      modelCalls: 2,
      toolCalls: 2
    });
    expect(clones).toEqual([[
      'source-0',
      'parentEnd',
      undefined,
      [{ search: '查询', replace: '确定' }]
    ]]);
  });
});
