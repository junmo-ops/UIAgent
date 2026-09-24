import type { SkillProvider } from '../core/skill-port';
import { skillTools } from './skill-tools';
import type { AgentTool } from '../../vendor/ui-agent-runtime/index.js';
import { Agent, type AgentRunResult } from '../../vendor/ui-agent-runtime/index.js';
import type { AssistantTurnRequest } from '@ui-agent/contracts';
import type { AssistantChatPort, AssistantTextObserver, AssistantChatRun } from '../core/assistant-chat-port';

const CHAT_RULES = [
  '你是 UI 助手的普通聊天 Agent，负责直接、准确地回答用户问题。',
  '你没有当前页面 DOM、源码或浏览器权限。技能工具只处理明确提供的输入，不得声称已经修改、检查或读取了当前页面。',
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
  tools?: readonly AgentTool<any, any>[];
}

export type AssistantChatAgentFactory = (
  input: AssistantChatAgentFactoryInput
) => AssistantChatAgentInstance;

export interface ClineAssistantChatOptions {
  skills?: SkillProvider;
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
      tools: input.tools ?? [],
      maxIterations: input.maxIterations
    }));
  }

  async answer(
    request: AssistantTurnRequest,
    observeText?: AssistantTextObserver,
    signal?: AbortSignal,
    observeRun?: (run: AssistantChatRun) => void
  ): Promise<string> {
    const run: AssistantChatRun = { steps: [] };
    const skill = this.options.skills?.open(request.skillId, request.skillVersion);
    const skillNotice = request.skillId ? `正在使用技能：${request.skillId}\n\n` : '';
    const agent = this.factory({
      providerId: 'openai-compatible',
      modelId: this.options.modelName,
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
      systemPrompt: `${CHAT_RULES}\n${skill?.prompt ?? ''}`,
      tools: skill ? skillTools(skill, (action, input, context, result, error) => {
        run.steps.push({ action, input, modelCall: context.iteration, toolCallId: context.toolCallId,
          timestamp: new Date().toISOString(), outcome: error ? 'failed' : 'succeeded',
          ...(result !== undefined ? { result: result.slice(0, 16000), resultChars: result.length, resultTruncated: result.length > 16000 } : {}),
          ...(error ? { error } : {}) });
      }) : [],
      maxIterations: skill ? 10 : 1
    });
    const unsubscribe = agent.subscribe(event => {
      if (event.type === 'assistant-text-delta' && event.text) observeText?.(event.text);
    });
    const abort = () => agent.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      if (!signal?.aborted && skillNotice) observeText?.(skillNotice);
      const result = await agent.run(JSON.stringify(request));
      run.runtime = result.diagnostics;
      if (result.error) throw result.error;
      const answer = result.outputText.trim();
      if (!answer) throw new Error('聊天模型没有返回回答');
      return skillNotice + answer;
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      try { observeRun?.(run); } catch { /* Diagnostics must not change the answer. */ }
    }
  }
}
