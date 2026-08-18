import { Agent, createTool, type AgentRunResult, type AgentTool } from '@dabaoabc/ui-agent-sdk';
import {
  type AssistantTurnRequest,
  type ClarificationOption
} from '@ui-agent/contracts';
import type { AssistantRouteResult, AssistantRouterPort } from '../core/assistant-router-port';

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

const stringProperty = (description: string): Record<string, unknown> => ({ type: 'string', description });

const ROUTER_RULES = [
  '你是 UI 助手的意图路由与普通问答 Agent。你必须且只能调用一个终止工具。',
  '根据用户真实语义和最近对话判断，不得使用关键词匹配，不得因为当前存在页面或选区就默认用户想修改页面。',
  '用户明确要求改变页面内容、结构、样式、布局或交互时调用 edit_page。edit_page 只形成完整修改意图，本 Agent 没有任何 DOM 或源码工具。',
  '用户在咨询知识、讨论方案、询问原因或进行日常对话，并未要求实际改变当前页面时调用 chat。',
  '如果一句话既可能是讨论也可能是执行修改，或者修改目标、范围会显著影响结果且无法从上下文确定，调用 clarify。',
  '若用户要求修改，但 context.hasWorkspace=false，应调用 clarify，明确告知需先点击“进入副本编辑”；不要询问一个系统无法直接执行的确认动作。',
  '若修改只可能针对具体局部元素但 context.hasSelection=false，应调用 clarify；若用户清楚要求修改整个副本，则可使用 workspace 范围。',
  '若当前输入是对上一条澄清问题的回答，应结合最近对话恢复完整意图，不要只转发孤立答案。',
  'chat 只表示交给独立的聊天 Agent 回答，不要在调用工具前输出答案。',
  '不要输出隐藏推理过程。'
].join('\n');

export interface AssistantRouterAgentInstance {
  run(input: string): Promise<AgentRunResult>;
}

export interface AssistantRouterAgentFactoryInput {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  systemPrompt: string;
  tools: readonly AgentTool<any, any>[];
  maxIterations: number;
}

export type AssistantRouterAgentFactory = (
  input: AssistantRouterAgentFactoryInput
) => AssistantRouterAgentInstance;

export interface ClineAssistantRouterOptions {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  maxIterations?: number;
  factory?: AssistantRouterAgentFactory;
}

export class ClineAssistantRouterAdapter implements AssistantRouterPort {
  readonly adapterId = 'cline-sdk-assistant-router';
  private readonly factory: AssistantRouterAgentFactory;
  private readonly maxIterations: number;

  constructor(private readonly options: ClineAssistantRouterOptions) {
    this.maxIterations = options.maxIterations ?? 3;
    this.factory = options.factory ?? (input => new Agent({
      providerId: input.providerId,
      modelId: input.modelId,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      maxIterations: input.maxIterations,
      toolExecution: 'sequential',
      completionPolicy: { requireCompletionTool: true }
    }));
  }

  async route(request: AssistantTurnRequest): Promise<AssistantRouteResult> {
    let completion: AssistantRouteResult | undefined;
    const tools: AgentTool<any, any>[] = [
      createTool<Record<string, never>, string>({
        name: 'chat',
        description: '把不需要实际修改当前页面的问题交给无 DOM 权限的聊天 Agent。',
        inputSchema: objectSchema({}),
        lifecycle: { completesRun: true },
        execute: async () => {
          completion = { kind: 'chat' };
          return '普通聊天意图已确认。';
        }
      }),
      createTool<{ instruction: string; targetScope: 'selection' | 'workspace' }, string>({
        name: 'edit_page',
        description: '把明确的页面修改需求交给受控源码编辑 Agent。',
        inputSchema: objectSchema({
          instruction: stringProperty('结合对话补全后的、可独立理解的页面修改要求。'),
          targetScope: { type: 'string', enum: ['selection', 'workspace'] }
        }, ['instruction', 'targetScope']),
        lifecycle: { completesRun: true },
        execute: async input => {
          completion = { kind: 'page_edit', ...input };
          return '页面修改意图已确认。';
        }
      }),
      createTool<{
        question: string;
        options?: ClarificationOption[];
        allowFreeText?: boolean;
      }, string>({
        name: 'clarify',
        description: '在是否执行修改或关键修改意图存在实质歧义时向用户追问。',
        inputSchema: objectSchema({
          question: stringProperty('只询问会影响下一步行动或结果的关键信息。'),
          options: {
            type: 'array', minItems: 2, maxItems: 4,
            items: objectSchema({
              id: stringProperty('稳定、简短的选项标识。'),
              label: stringProperty('选项标题。'),
              description: stringProperty('可选的影响或区别说明。')
            }, ['id', 'label'])
          },
          allowFreeText: { type: 'boolean' }
        }, ['question']),
        lifecycle: { completesRun: true },
        execute: async input => {
          completion = {
            kind: 'clarification',
            clarificationId: request.turnId,
            question: input.question,
            ...(input.options && { options: input.options }),
            allowFreeText: input.options ? input.allowFreeText ?? true : true
          };
          return input.question;
        }
      })
    ];

    try {
      const agent = this.factory({
        providerId: 'openai-compatible',
        modelId: this.options.modelName,
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
        systemPrompt: ROUTER_RULES,
        tools,
        maxIterations: this.maxIterations
      });
      const result = await agent.run(JSON.stringify(request));
      return completion ?? {
        kind: 'failed',
        code: 'ASSISTANT_ROUTER_INCOMPLETE',
        message: result.error?.message ?? `模型没有完成意图判断（status=${result.status}）`
      };
    } catch (error) {
      return {
        kind: 'failed',
        code: 'ASSISTANT_ROUTER_ERROR',
        message: error instanceof Error ? error.message : '助手意图判断失败'
      };
    }
  }
}

export function clineAssistantRouterFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): ClineAssistantRouterAdapter {
  if (env.MODEL_MODE !== 'remote') throw new Error('助手路由必须设置 MODEL_MODE=remote');
  if (!env.MODEL_BASE_URL || !env.MODEL_API_KEY || !env.MODEL_NAME) {
    throw new Error('助手路由必须设置 MODEL_BASE_URL、MODEL_API_KEY 和 MODEL_NAME');
  }
  return new ClineAssistantRouterAdapter({
    baseUrl: env.MODEL_BASE_URL,
    apiKey: env.MODEL_API_KEY,
    modelName: env.MODEL_NAME,
    ...(env.MODEL_MAX_ITERATIONS && { maxIterations: Math.min(5, Number(env.MODEL_MAX_ITERATIONS)) })
  });
}
