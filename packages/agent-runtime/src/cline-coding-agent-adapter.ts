import {
  Agent,
  createTool,
  type AgentRunResult,
  type AgentTool,
  type AgentToolContext
} from '@cline/sdk';
import type { SourceTurnResponse } from '@ui-agent/contracts';
import {
  type CodingAgentCheckpoint,
  type CodingAgentObserver,
  type CodingAgentPort,
  type CodingAgentRunResult,
  type CodingAgentStep,
  type CodingAgentTurn,
  type CodingWorkspaceTools
} from './coding-agent-port';
import { CONTROLLED_INTERACTION_INSTRUCTIONS } from './controlled-interaction-instructions';

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

const stringProperty = (description: string): Record<string, unknown> => ({
  type: 'string',
  description
});

const clineSourceRules = [
  '你是静态网页源码编辑 Agent。你只能使用本次会话显式提供的源码工具。',
  '页面只用于 UI 需求示意，不需要真实接口、脚本或业务提交。',
  '工作区包含 index.html、snapshot.css、outline.json 和 source-map.json。',
  '先调用 list_files，并优先搜索或读取 outline.json 来定位语义结构；不要直接读取整个大文件。',
  'index.html 保存页面结构，snapshot.css 保存冻结样式。结构与文案修改 index.html，视觉修改 snapshot.css。',
  'outline.json 与 source-map.json 由系统维护，只能读取，不能修改。',
  'replace_text 的 search 必须来自刚刚读取的源码，且应足够唯一；不要猜测源码。',
  '需要在文件开头、末尾或明确锚点旁插入内容时使用 apply_patch，不要为了追加内容反复寻找唯一的文件尾字符串。',
  'inspect_element 会返回 domText 和 styleClasses；domText 只证明文字存在于源码，不能证明渲染后可见。需要了解现有视觉样式时直接用 read_style_rule 读取完整规则，不要连续切片读取 snapshot.css。',
  '移动已有元素必须使用 move_element，禁止用大段 replace_text 删除后重建或重排。',
  '新增与现有组件同款的结构时优先使用 clone_element，再用局部替换或 Patch 完成差异；不要手写复制整段组件源码。',
  '同一个工具错误重复出现时必须更换策略；不得用重复读取和重复替换消耗迭代次数。',
  '如果有 selectedSourceId，可用 inspect_element 读取该元素的紧凑源码。',
  '优先复用已有结构和 class；新增同类组件时复制相邻源码结构，再修改必要内容。',
  '不得添加 script、事件属性、远程资源、接口请求、表单 action 或 javascript: URL。',
  CONTROLLED_INTERACTION_INSTRUCTIONS,
  '每次修改后检查工具结果；目标达成后先调用 validate_workspace。若提示元素被 overflow 裁剪，必须调整父容器尺寸、overflow 或定位，不能直接声明完成。',
  '不要只用自然语言声称完成。没有调用 finish 或 clarify，本轮就不算完成。',
  '不要做与用户请求无关的重构。'
].join('\n');

export interface ClineAgentInstance {
  run(input: string): Promise<AgentRunResult>;
}

export interface ClineAgentFactoryInput {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  systemPrompt: string;
  tools: readonly AgentTool<any, any>[];
  maxIterations: number;
}

export type ClineAgentFactory = (input: ClineAgentFactoryInput) => ClineAgentInstance;

export interface ClineCodingAgentOptions {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  maxIterations?: number;
  factory?: ClineAgentFactory;
}

type Completion =
  | { kind: 'completed'; summary: string; validation: string; revision: number }
  | { kind: 'clarification'; question: string };

function safeEmit(observe: CodingAgentObserver | undefined, event: Parameters<CodingAgentObserver>[0]): void {
  try {
    observe?.(event);
  } catch {
    // Telemetry must never alter the outcome of an editing turn.
  }
}

function failedResponse(error: unknown): SourceTurnResponse {
  return {
    kind: 'failed',
    code: 'CLINE_AGENT_ERROR',
    message: error instanceof Error ? error.message : 'Cline 源码 Agent 执行失败'
  };
}

export class ClineCodingAgentAdapter implements CodingAgentPort {
  readonly adapterId = 'cline-sdk';
  private readonly maxIterations: number;
  private readonly factory: ClineAgentFactory;

  constructor(private readonly options: ClineCodingAgentOptions) {
    this.maxIterations = options.maxIterations ?? 30;
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

  async run(
    turn: CodingAgentTurn,
    workspace: CodingWorkspaceTools,
    observe?: CodingAgentObserver
  ): Promise<CodingAgentRunResult> {
    const startedAt = new Date().toISOString();
    const steps: CodingAgentStep[] = [];
    let completion: Completion | undefined;
    let rolledBack = false;
    const repeatedFailures = new Map<string, number>();
    let checkpoint: CodingAgentCheckpoint = {
      version: 1,
      adapterId: this.adapterId,
      workspaceId: turn.workspaceId,
      turnId: turn.request.turnId,
      status: 'running',
      modelCalls: 0,
      toolCalls: 0,
      stepCount: 0,
      updatedAt: startedAt
    };

    safeEmit(observe, {
      type: 'coding-agent.turn.started',
      timestamp: startedAt,
      adapterId: this.adapterId,
      workspaceId: turn.workspaceId,
      request: turn.request
    });

    const rollback = async () => {
      if (rolledBack || completion?.kind === 'completed') return;
      rolledBack = true;
      await workspace.rollback();
    };

    const record = (
      action: string,
      input: unknown,
      context: AgentToolContext,
      result?: string,
      error?: string,
      countAsTool = true
    ) => {
      const timestamp = new Date().toISOString();
      const step: CodingAgentStep = {
        modelCall: context.iteration,
        action,
        input,
        ...(result ? { result: result.slice(0, 16_000) } : {}),
        ...(error ? { error } : {})
      };
      steps.push(step);
      checkpoint = {
        ...checkpoint,
        modelCalls: Math.max(checkpoint.modelCalls, context.iteration),
        toolCalls: checkpoint.toolCalls + (countAsTool ? 1 : 0),
        stepCount: steps.length,
        lastAction: action,
        updatedAt: timestamp
      };
      safeEmit(observe, {
        type: 'coding-agent.step.completed',
        timestamp,
        adapterId: this.adapterId,
        workspaceId: turn.workspaceId,
        step
      });
      safeEmit(observe, { type: 'coding-agent.checkpoint.updated', timestamp, checkpoint });
    };

    const execute = async <TInput>(
      action: string,
      input: TInput,
      context: AgentToolContext,
      operation: () => Promise<string>
    ): Promise<string> => {
      try {
        const result = await operation();
        record(action, input, context, result);
        return result;
      } catch (error) {
        const baseMessage = error instanceof Error ? error.message : String(error);
        const failureKey = `${action}:${baseMessage}`;
        const repeated = (repeatedFailures.get(failureKey) ?? 0) + 1;
        repeatedFailures.set(failureKey, repeated);
        const message = repeated >= 2
          ? `${baseMessage}。同一错误已重复 ${repeated} 次，请停止当前策略；追加内容请改用 apply_patch 的 start/end，无法安全继续则调用 clarify。`
          : baseMessage;
        record(action, input, context, undefined, message);
        throw new Error(message);
      }
    };

    const tools: AgentTool<any, any>[] = [
      createTool<Record<string, never>, string>({
        name: 'list_files',
        description: '列出当前静态源码工作区允许访问的文件及字符数。',
        inputSchema: objectSchema({}),
        execute: (input, context) => execute(
          'list_files',
          input,
          context,
          async () => JSON.stringify(await workspace.listFiles())
        )
      }),
      createTool<{ query: string; path?: string }, string>({
        name: 'search_text',
        description: '在允许的源码文件中搜索文字，返回命中位置和附近片段。',
        inputSchema: objectSchema({
          query: stringProperty('要搜索的精确文字或源码片段。'),
          path: stringProperty('可选文件路径，只允许工作区内文件。')
        }, ['query']),
        execute: (input, context) => execute(
          'search_text',
          input,
          context,
          () => workspace.searchText(input.query, input.path)
        )
      }),
      createTool<{
        path: string;
        startLine?: number;
        endLine?: number;
        startChar?: number;
        endChar?: number;
      }, string>({
        name: 'read_file',
        description: '按行号或字符区间读取允许的源码文件局部内容。',
        inputSchema: objectSchema({
          path: stringProperty('工作区内文件路径。'),
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          startChar: { type: 'integer', minimum: 0 },
          endChar: { type: 'integer', minimum: 0 }
        }, ['path']),
        execute: (input, context) => execute(
          'read_file',
          input,
          context,
          () => workspace.readFile(
            input.path,
            input.startLine,
            input.endLine,
            input.startChar,
            input.endChar
          )
        )
      }),
      createTool<{ sourceId: string }, string>({
        name: 'inspect_element',
        description: '按 data-ui-source-id 读取页面元素的局部源码、文字和样式线索。',
        inputSchema: objectSchema({
          sourceId: stringProperty('元素的 data-ui-source-id。')
        }, ['sourceId']),
        execute: (input, context) => execute(
          'inspect_element',
          input,
          context,
          () => workspace.inspectElement(input.sourceId)
        )
      }),
      createTool<{ className: string }, string>({
        name: 'read_style_rule',
        description: '按 inspect_element 返回的 class 名一次读取 snapshot.css 中对应的完整样式规则。',
        inputSchema: objectSchema({
          className: stringProperty('单个样式类名，例如 ui-snapshot-style-38，可带或不带开头的点。')
        }, ['className']),
        execute: (input, context) => execute(
          'read_style_rule',
          input,
          context,
          () => workspace.readStyleRule(input.className)
        )
      }),
      createTool<{ path: string; search: string; replace: string }, string>({
        name: 'replace_text',
        description: '在允许写入的源码文件中执行一次精确替换。search 必须来自最近读取的原文。',
        inputSchema: objectSchema({
          path: stringProperty('只允许 index.html 或 snapshot.css。'),
          search: stringProperty('要替换的精确原文，应当足够唯一。'),
          replace: stringProperty('替换后的源码。')
        }, ['path', 'search', 'replace']),
        execute: (input, context) => execute(
          'replace_text',
          input,
          context,
          () => workspace.replaceText(input.path, input.search, input.replace)
        )
      }),
      createTool<{
        path: string;
        edits: Array<
          | { kind: 'replace'; search: string; replace: string }
          | { kind: 'insert'; position: 'start' | 'end' | 'before' | 'after'; text: string; anchor?: string }
        >;
      }, string>({
        name: 'apply_patch',
        description: '原子应用一组受控源码编辑。支持精确替换，以及在文件开头、末尾或唯一锚点前后插入；适合追加 CSS。',
        inputSchema: objectSchema({
          path: stringProperty('只允许 index.html 或 snapshot.css。'),
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: objectSchema({
              kind: { type: 'string', enum: ['replace', 'insert'] },
              search: { type: 'string' },
              replace: { type: 'string' },
              position: { type: 'string', enum: ['start', 'end', 'before', 'after'] },
              text: { type: 'string' },
              anchor: { type: 'string' }
            }, ['kind'])
          }
        }, ['path', 'edits']),
        execute: (input, context) => execute(
          'apply_patch',
          input,
          context,
          () => workspace.applyPatch(input.path, input.edits)
        )
      }),
      createTool<{ sourceId: string; search: string; replace: string }, string>({
        name: 'replace_in_element',
        description: '把精确替换限制在指定 sourceId 元素内部，适合修改已选元素的文案或属性。',
        inputSchema: objectSchema({
          sourceId: stringProperty('目标元素的 data-ui-source-id。'),
          search: stringProperty('元素内部刚刚读取到的精确原文。'),
          replace: stringProperty('替换后的源码。')
        }, ['sourceId', 'search', 'replace']),
        execute: (input, context) => execute(
          'replace_in_element',
          input,
          context,
          () => workspace.replaceInElement(input.sourceId, input.search, input.replace)
        )
      }),
      createTool<{
        sourceId: string;
        position: 'parentStart' | 'parentEnd' | 'before' | 'after';
        targetSourceId?: string;
      }, string>({
        name: 'move_element',
        description: '按 sourceId 原样移动现有元素，保留其完整结构、样式类和子节点。before/after 必须提供目标 sourceId。',
        inputSchema: objectSchema({
          sourceId: stringProperty('要移动的现有元素 sourceId。'),
          position: { type: 'string', enum: ['parentStart', 'parentEnd', 'before', 'after'] },
          targetSourceId: stringProperty('before/after 的目标元素 sourceId。')
        }, ['sourceId', 'position']),
        execute: (input, context) => execute(
          'move_element',
          input,
          context,
          () => workspace.moveElement(input.sourceId, input.position, input.targetSourceId)
        )
      }),
      createTool<{
        templateSourceId: string;
        position: 'replace' | 'parentStart' | 'parentEnd' | 'before' | 'after';
        targetSourceId?: string;
        replacements: Array<{ search: string; replace: string }>;
      }, string>({
        name: 'clone_element',
        description: '克隆现有同款组件并生成全新的 sourceId，可在克隆内容中执行少量精确替换。',
        inputSchema: objectSchema({
          templateSourceId: stringProperty('要复用的现有组件 sourceId。'),
          position: { type: 'string', enum: ['replace', 'parentStart', 'parentEnd', 'before', 'after'] },
          targetSourceId: stringProperty('插入或替换的目标 sourceId。'),
          replacements: {
            type: 'array',
            maxItems: 50,
            items: objectSchema({
              search: stringProperty('模板内唯一原文。'),
              replace: stringProperty('替换内容。')
            }, ['search', 'replace'])
          }
        }, ['templateSourceId', 'position', 'replacements']),
        execute: (input, context) => execute(
          'clone_element',
          input,
          context,
          () => workspace.cloneElement(
            input.templateSourceId,
            input.position,
            input.targetSourceId,
            input.replacements
          )
        )
      }),
      createTool<Record<string, never>, string>({
        name: 'validate_workspace',
        description: '检查当前工作副本是否仍为安全、可预览的静态页面。',
        inputSchema: objectSchema({}),
        execute: (input, context) => execute(
          'validate_workspace',
          input,
          context,
          () => workspace.validate()
        )
      }),
      createTool<{ summary: string }, string>({
        name: 'finish',
        description: '目标已经达成时，校验并提交工作副本，结束本轮。',
        inputSchema: objectSchema({
          summary: stringProperty('面向用户的简洁修改说明。')
        }, ['summary']),
        lifecycle: { completesRun: true },
        execute: async (input, context) => {
          try {
            const validation = await workspace.validate();
            const revision = await workspace.commit(input.summary);
            completion = { kind: 'completed', summary: input.summary, validation, revision };
            const result = `${input.summary}（${validation}；revision=${revision}）`;
            record('finish', input, context, result, undefined, false);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            record('finish', input, context, undefined, message, false);
            throw error;
          }
        }
      }),
      createTool<{ question: string }, string>({
        name: 'clarify',
        description: '缺少关键信息且无法安全编辑时，回滚本轮并向用户提出一个具体问题。',
        inputSchema: objectSchema({
          question: stringProperty('需要用户补充的具体信息。')
        }, ['question']),
        lifecycle: { completesRun: true },
        execute: async (input, context) => {
          await rollback();
          completion = { kind: 'clarification', question: input.question };
          record('clarify', input, context, input.question, undefined, false);
          return input.question;
        }
      })
    ];

    let response: SourceTurnResponse;
    try {
      const files = await workspace.listFiles();
      const agent = this.factory({
        providerId: 'openai-compatible',
        modelId: this.options.modelName,
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
        systemPrompt: clineSourceRules,
        tools,
        maxIterations: this.maxIterations
      });
      const result = await agent.run(JSON.stringify({
        instruction: turn.request.instruction,
        selectedSourceId: turn.request.sourceId,
        conversation: turn.conversation.slice(-8),
        files
      }));
      checkpoint = {
        ...checkpoint,
        modelCalls: Math.max(checkpoint.modelCalls, result.iterations)
      };
      if (completion?.kind === 'completed') {
        response = {
          kind: 'completed',
          summary: `${completion.summary}（${completion.validation}）`,
          revision: completion.revision,
          modelCalls: checkpoint.modelCalls,
          toolCalls: checkpoint.toolCalls
        };
      } else if (completion?.kind === 'clarification') {
        response = { kind: 'clarification', question: completion.question };
      } else {
        await rollback();
        response = failedResponse(
          result.error ?? new Error(`Cline 运行结束但没有调用 finish 或 clarify（status=${result.status}）`)
        );
      }
    } catch (error) {
      try {
        await rollback();
      } catch {
        // Preserve the primary agent error.
      }
      response = failedResponse(error);
    }

    const timestamp = new Date().toISOString();
    checkpoint = {
      ...checkpoint,
      status: response.kind === 'completed'
        ? 'completed'
        : response.kind === 'clarification'
          ? 'clarification'
          : 'failed',
      updatedAt: timestamp
    };
    safeEmit(observe, {
      type: 'coding-agent.turn.completed',
      timestamp,
      adapterId: this.adapterId,
      workspaceId: turn.workspaceId,
      response,
      checkpoint
    });
    return { response, checkpoint, steps };
  }
}

export function clineCodingAgentFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): ClineCodingAgentAdapter {
  if (env.MODEL_MODE !== 'remote') {
    throw new Error('CODING_AGENT_ADAPTER=cline 时必须设置 MODEL_MODE=remote');
  }
  if (!env.MODEL_BASE_URL || !env.MODEL_API_KEY || !env.MODEL_NAME) {
    throw new Error('Cline Adapter 必须设置 MODEL_BASE_URL、MODEL_API_KEY 和 MODEL_NAME');
  }
  const parsedMaxIterations = Number(env.CLINE_MAX_ITERATIONS ?? 30);
  if (!Number.isInteger(parsedMaxIterations) || parsedMaxIterations < 1) {
    throw new Error('CLINE_MAX_ITERATIONS 必须是大于 0 的整数');
  }
  return new ClineCodingAgentAdapter({
    baseUrl: env.MODEL_BASE_URL,
    apiKey: env.MODEL_API_KEY,
    modelName: env.MODEL_NAME,
    maxIterations: parsedMaxIterations
  });
}
