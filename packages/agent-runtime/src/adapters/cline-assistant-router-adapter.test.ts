import type { AgentRunResult, AgentTool, AgentToolContext } from '@dabaoabc/ui-agent-sdk';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type AssistantTurnRequest } from '@ui-agent/contracts';
import {
  ClineAssistantRouterAdapter,
  type AssistantRouterAgentFactoryInput
} from './cline-assistant-router-adapter';

const request: AssistantTurnRequest = {
  protocolVersion: PROTOCOL_VERSION,
  turnId: '11111111-1111-4111-8111-111111111111',
  traceId: '22222222-2222-4222-8222-222222222222',
  instruction: '为什么这个布局会溢出？',
  context: { hasWorkspace: true, hasSelection: true },
  conversation: []
};

const context: AgentToolContext = { agentId: 'router-test', iteration: 1 };
const result = (): AgentRunResult => ({
  agentId: 'router-test',
  runId: 'router-run',
  status: 'completed',
  iterations: 1,
  outputText: '',
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
});

function tool<T>(config: AssistantRouterAgentFactoryInput, name: string): AgentTool<T, string> {
  const found = config.tools.find(item => item.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found as AgentTool<T, string>;
}

function adapter(run: (config: AssistantRouterAgentFactoryInput) => Promise<void>) {
  return new ClineAssistantRouterAdapter({
    baseUrl: 'https://example.test',
    apiKey: 'test-key',
    modelName: 'test-model',
    factory: config => ({
      async run() {
        await run(config);
        return result();
      }
    })
  });
}

describe('ClineAssistantRouterAdapter', () => {
  it('routes ordinary questions without exposing source or DOM tools', async () => {
    const router = adapter(async config => {
      expect(config.tools.map(item => item.name)).toEqual(['chat', 'edit_page', 'clarify']);
      expect(config.systemPrompt).toContain('不得使用关键词匹配');
      await tool<Record<string, never>>(config, 'chat').execute({}, context);
    });

    await expect(router.route(request)).resolves.toEqual({ kind: 'chat' });
  });

  it('returns a normalized edit intent without performing the edit', async () => {
    const router = adapter(async config => {
      await tool<{ instruction: string; targetScope: 'selection' }>(config, 'edit_page').execute({
        instruction: '将选中卡片的标题改为“账户余额”并保持其余样式不变',
        targetScope: 'selection'
      }, context);
    });

    await expect(router.route({ ...request, instruction: '标题换一下' })).resolves.toEqual({
      kind: 'page_edit',
      instruction: '将选中卡片的标题改为“账户余额”并保持其余样式不变',
      targetScope: 'selection'
    });
  });

  it('returns a structured clarification for material ambiguity', async () => {
    const router = adapter(async config => {
      await tool<{ question: string; options: Array<{ id: string; label: string }> }>(config, 'clarify').execute({
        question: '你希望我解释实现思路，还是直接修改当前副本？',
        options: [
          { id: 'explain', label: '只解释' },
          { id: 'edit', label: '直接修改' }
        ]
      }, context);
    });

    await expect(router.route(request)).resolves.toMatchObject({
      kind: 'clarification',
      clarificationId: request.turnId,
      allowFreeText: true
    });
  });
});
