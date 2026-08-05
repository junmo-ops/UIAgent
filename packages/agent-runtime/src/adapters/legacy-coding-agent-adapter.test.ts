import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type SourceAgentDecision, type SourceTurnRequest } from '@ui-agent/contracts';
import type { CodingAgentEvent, CodingWorkspaceTools } from '../core/coding-agent-port';
import { LegacyCodingAgentAdapter, codingAgentPortFromEnvironment } from './legacy-coding-agent-adapter';
import { SourceEditingAgent, type SourceDecisionMaker } from '../source-editing/source-agent';

class SequenceDecisions implements SourceDecisionMaker {
  constructor(private readonly decisions: SourceAgentDecision[]) {}
  async decide() {
    const decision = this.decisions.shift();
    if (!decision) throw new Error('decision sequence exhausted');
    return decision;
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

function workspaceTools(): CodingWorkspaceTools {
  let html = '<button data-ui-source-id="source-0">查询</button>';
  return {
    listFiles: async () => [{ path: 'index.html', chars: html.length }],
    searchText: async query => html.includes(query) ? html : '没有找到',
    readFile: async () => html,
    inspectElement: async () => 'visibleText: "查询"',
    readStyleRule: async className => `.${className}{color:red}`,
    replaceText: async (_path, search, replace) => {
      html = html.replace(search, replace);
      return '替换成功';
    },
    applyPatch: async () => 'Patch 成功',
    replaceInElement: async (_sourceId, search, replace) => {
      html = html.replace(search, replace);
      return '元素内替换成功';
    },
    moveElement: async () => '移动成功',
    cloneElement: async () => '克隆成功',
    validate: async () => '工作区校验通过',
    commit: async () => 1,
    rollback: async () => undefined
  };
}

describe('LegacyCodingAgentAdapter', () => {
  it('exposes the legacy source agent through the provider-neutral port', async () => {
    const adapter = new LegacyCodingAgentAdapter(new SourceEditingAgent(new SequenceDecisions([
      {
        action: 'replaceInElement',
        sourceId: 'source-0',
        search: '查询',
        replace: '确定',
        reason: '修改按钮文案'
      },
      { action: 'finish', summary: '已修改按钮文案' }
    ])));
    const events: CodingAgentEvent[] = [];
    const result = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspaceTools(), event => events.push(event));

    expect(result.response).toMatchObject({ kind: 'completed', revision: 1 });
    expect(result.checkpoint).toMatchObject({
      adapterId: 'legacy-source-agent',
      status: 'completed',
      modelCalls: 2,
      toolCalls: 2,
      stepCount: 2,
      lastAction: 'finish'
    });
    expect(result.steps.map(step => step.action)).toEqual(['replaceInElement', 'finish']);
    expect(events.map(event => event.type)).toEqual([
      'coding-agent.turn.started',
      'coding-agent.step.completed',
      'coding-agent.checkpoint.updated',
      'coding-agent.step.completed',
      'coding-agent.checkpoint.updated',
      'coding-agent.turn.completed'
    ]);
  });

  it('isolates observer failures from the editing turn', async () => {
    const adapter = new LegacyCodingAgentAdapter(new SourceEditingAgent(new SequenceDecisions([
      { action: 'clarify', question: '请补充目标文案' }
    ])));
    await expect(adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspaceTools(), () => {
      throw new Error('observer failed');
    })).resolves.toMatchObject({
      response: { kind: 'clarification' },
      checkpoint: { status: 'clarification' }
    });
  });

  it('defaults to the legacy adapter and rejects unknown adapters', () => {
    expect(codingAgentPortFromEnvironment({ MODEL_MODE: 'mock' }).adapterId).toBe('legacy-source-agent');
    expect(codingAgentPortFromEnvironment({
      MODEL_MODE: 'remote',
      MODEL_BASE_URL: 'https://example.test',
      MODEL_API_KEY: 'test-key',
      MODEL_NAME: 'test-model',
      CODING_AGENT_ADAPTER: 'cline'
    }).adapterId).toBe('cline-sdk');
    expect(() => codingAgentPortFromEnvironment({
      MODEL_MODE: 'mock',
      CODING_AGENT_ADAPTER: 'unknown'
    })).toThrow('不支持的 Coding Agent Adapter');
  });
});
