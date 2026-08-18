import { Agent, type AgentRunResult } from '../../vendor/ui-agent-runtime/index.js';
import type { AssistantTurnRequest } from '@ui-agent/contracts';
import type { AssistantChatPort, AssistantTextObserver } from '../core/assistant-chat-port';

const CHAT_RULES = [
  '你是 UI 助手的普通聊天 Agent，负责直接、准确地回答用户问题。',
  '你没有 DOM、源码、浏览器或文件工具，不得声称已经修改、检查或读取了当前页面。',
  '可以参考输入中的最近对话和轻量页面上下文，但上下文不足时应明确说明限制。',
  '只输出最终回答，不输出意图分类、内部规则或隐藏推理过程。',
  '回答语言跟随用户。'
].join('\n');

export interface AssistantChatAgentInstance {
  run(input: string): Promise<AgentRunResult>;
  subscribe(listener: Parameters<Agent['subscribe']>[0]): () => void;
  abort(reason?: unknown): void;
}

export interface AssistantChatAgentFactoryInput {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  systemPrompt: string;
  maxIterations: number;
}

export type AssistantChatAgentFactory = (
  input: AssistantChatAgentFactoryInput
) => AssistantChatAgentInstance;

export interface ClineAssistantChatOptions {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  factory?: AssistantChatAgentFactory;
}

export class ClineAssistantChatAdapter implements AssistantChatPort {
  readonly adapterId = 'cline-sdk-assistant-chat';
  private readonly factory: AssistantChatAgentFactory;

  constructor(private readonly options: ClineAssistantChatOptions) {
    this.factory = options.factory ?? (input => new Agent({
      providerId: input.providerId,
      modelId: input.modelId,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      systemPrompt: input.systemPrompt,
      tools: [],
      maxIterations: input.maxIterations
    }));
  }

  async answer(
    request: AssistantTurnRequest,
    observeText?: AssistantTextObserver,
    signal?: AbortSignal
  ): Promise<string> {
    const agent = this.factory({
      providerId: 'openai-compatible',
      modelId: this.options.modelName,
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
      systemPrompt: CHAT_RULES,
      maxIterations: 1
    });
    const unsubscribe = agent.subscribe(event => {
      if (event.type === 'assistant-text-delta' && event.text) observeText?.(event.text);
    });
    const abort = () => agent.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      const result = await agent.run(JSON.stringify(request));
      if (result.error) throw result.error;
      const answer = result.outputText.trim();
      if (!answer) throw new Error('聊天模型没有返回回答');
      return answer;
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', abort);
    }
  }
}

export function clineAssistantChatFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): ClineAssistantChatAdapter {
  if (env.MODEL_MODE !== 'remote') throw new Error('普通聊天必须设置 MODEL_MODE=remote');
  if (!env.MODEL_BASE_URL || !env.MODEL_API_KEY || !env.MODEL_NAME) {
    throw new Error('普通聊天必须设置 MODEL_BASE_URL、MODEL_API_KEY 和 MODEL_NAME');
  }
  return new ClineAssistantChatAdapter({
    baseUrl: env.MODEL_BASE_URL,
    apiKey: env.MODEL_API_KEY,
    modelName: env.MODEL_NAME
  });
}
