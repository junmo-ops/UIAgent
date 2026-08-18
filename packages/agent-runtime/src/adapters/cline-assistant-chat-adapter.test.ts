import { Agent, type AgentRunResult } from '../../vendor/ui-agent-runtime/index.js';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type AssistantTurnRequest } from '@ui-agent/contracts';
import { ClineAssistantChatAdapter } from './cline-assistant-chat-adapter';

const request: AssistantTurnRequest = {
  protocolVersion: PROTOCOL_VERSION,
  turnId: '11111111-1111-4111-8111-111111111111',
  traceId: '22222222-2222-4222-8222-222222222222',
  instruction: '解释一下 flex-shrink',
  context: { hasWorkspace: false, hasSelection: false },
  conversation: []
};

const result: AgentRunResult = {
  agentId: 'chat-test',
  runId: 'chat-run',
  status: 'completed',
  iterations: 1,
  outputText: 'flex-shrink 控制空间不足时项目如何收缩。',
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
};

describe('ClineAssistantChatAdapter', () => {
  it('forwards only answer text deltas and returns the complete answer', async () => {
    let listener: Parameters<Agent['subscribe']>[0] | undefined;
    const adapter = new ClineAssistantChatAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        subscribe(next) { listener = next; return () => { listener = undefined; }; },
        abort() {},
        async run() {
          expect(config.maxIterations).toBe(1);
          expect(config.systemPrompt).toContain('没有 DOM');
          listener?.({ type: 'assistant-reasoning-delta', text: 'hidden' } as never);
          listener?.({ type: 'assistant-text-delta', text: 'flex-shrink 控制' } as never);
          listener?.({ type: 'assistant-text-delta', text: '项目收缩。' } as never);
          return result;
        }
      })
    });
    const deltas: string[] = [];

    await expect(adapter.answer(request, text => deltas.push(text))).resolves.toBe(result.outputText);
    expect(deltas).toEqual(['flex-shrink 控制', '项目收缩。']);
  });
});
