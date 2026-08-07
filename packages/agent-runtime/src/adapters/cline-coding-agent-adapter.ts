import {
  Agent,
  createTool,
  type AgentRunResult,
  type AgentTool,
  type AgentToolContext
} from '@cline/sdk';
import {
  domOperationSchema,
  type ClarificationOption,
  type DomOperation,
  type SourceTurnResponse
} from '@ui-agent/contracts';
import { z } from 'zod';
import {
  type CodingAgentCheckpoint,
  type CodingAgentObserver,
  type CodingAgentPort,
  type CodingAgentRunResult,
  type CodingAgentStep,
  type CodingAgentTurn,
  type CodingWorkspaceTools
} from '../core/coding-agent-port';
import { CONTROLLED_INTERACTION_INSTRUCTIONS } from '../source-editing/controlled-interaction-instructions';

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
  'inspect_element 会返回目标、祖先和兄弟节点的布局上下文（捕获时矩形与关键计算样式）、domText 和 styleClasses。必须用布局上下文理解视觉关系；domText 只证明文字存在于源码，不能证明渲染后可见。需要了解完整视觉样式时用 read_style_rule，不要连续切片读取 snapshot.css。',
  '需要检查多个元素或样式时，优先使用 inspect_elements 和 read_style_rules 批量读取，避免逐个调用消耗迭代次数。',
  '移动已有元素必须使用 move_element，禁止用大段 replace_text 删除后重建或重排。',
  '删除完整元素必须使用 remove_element(sourceId)，禁止读取或复制完整 outerHTML 后再用 replace_text 删除。',
  '完整文本使用 set_element_text；属性增删使用 set_element_attributes；插入、包裹、解包和排序分别使用 insert_element、wrap_element、unwrap_element、reorder_children。',
  '多个相关 DOM 修改优先使用 apply_dom_operations 原子批量执行；任一项失败会整体回滚。',
  '新增与现有组件同款的结构时优先使用 clone_element，再用局部替换或 Patch 完成差异；不要手写复制整段组件源码。',
  '同一个工具错误重复出现时必须更换策略；不得用重复读取和重复替换消耗迭代次数。',
  '如果有 selectedSourceId，可用 inspect_element 读取该元素的紧凑源码。',
  '空间定位优先级：用户明确指定页面、视口、弹窗、表格等容器时以该容器为准；否则所有“顶部、底部、左侧、右侧、中间、附近”等位置都必须以 selectedSourceId 或其最近语义祖先为锚点。',
  '需求涉及选中元素的相邻组件时，只扩展到最近公共父容器。除非用户明确说页面、浏览器视口、全局、悬浮或固定，否则禁止把新增模块放到页面根节点或使用 position:fixed。',
  '新增元素后必须调用 validate_spatial_scope，说明实际容器和新增顶层 sourceId；无法确定参照容器时调用 clarify，不得自行猜测全局位置。',
  '执行前判断需求是否存在会显著影响最终视觉结果的歧义。若存在两个或以上合理方案，不得自行选择，必须 clarify；位置、范围、布局方式、参考样式或新增内容不明确都属于常见歧义。',
  '澄清前可以读取必要的局部结构和父容器布局，但不要修改源码。问题只询问无法从源码确定的关键信息，并尽量提供 2-4 个互斥、具体的选项；低风险且结果唯一的局部修改不要反问。',
  '任何源码写入前必须先调用 declare_intent，明确目标、相关 sourceId、视觉约束和歧义判断。仍有多个合理结果时不要调用 declare_intent，直接 clarify。',
  '如果请求包含 replyToClarificationId，应把当前 instruction 理解为用户对上一条澄清问题的回答，并结合 conversation 继续原需求，不要重复询问已经回答的信息。',
  '优先复用已有结构和 class；新增同类组件时复制相邻源码结构，再修改必要内容。',
  '不得添加 script、事件属性、远程资源、接口请求、表单 action 或 javascript: URL。',
  CONTROLLED_INTERACTION_INSTRUCTIONS,
  '每次修改后检查工具结果；目标达成后先调用 validate_workspace。若提示元素被 overflow 裁剪，必须调整父容器尺寸、overflow 或定位，不能直接声明完成。',
  '不要只用自然语言声称完成。没有调用 finish 或 clarify，本轮就不算完成。',
  '不要做与用户请求无关的重构。'
].join('\n');

const DEFAULT_MAX_ITERATIONS = 45;
const FINALIZATION_WINDOW = 3;
const MAX_IDENTICAL_TOOL_FAILURES = 3;
const BUDGETED_READ_ACTIONS = new Set([
  'list_files', 'search_text', 'read_file', 'inspect_element', 'inspect_elements',
  'read_style_rule', 'read_style_rules'
]);

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
  | {
      kind: 'clarification';
      question: string;
      options?: ClarificationOption[];
      allowFreeText: boolean;
    };

interface ClarifyToolInput {
  question: string;
  options?: ClarificationOption[];
  allowFreeText?: boolean;
}

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

function sourceIdsIn(value: string): Set<string> {
  return new Set([...value.matchAll(/\bdata-ui-source-id\s*=\s*["'](source-\d+)["']/gi)]
    .map(match => match[1]!));
}

function hasExplicitGlobalPlacement(instruction: string): boolean {
  return /(?:页面|浏览器|视口|全局).{0,12}(?:顶部|中部|中间|底部|左侧|右侧|悬浮|固定)/.test(instruction)
    || /(?:悬浮|固定).{0,12}(?:页面|浏览器|视口|全局)/.test(instruction);
}

function ancestrySourceIds(inspection: string): string[] {
  const path = inspection.match(/结构路径:\s*([^\n]+)/)?.[1] ?? '';
  return [...path.matchAll(/(source-\d+)</g)].map(match => match[1]!);
}

function cssClassNamesIn(css: string): Set<string> {
  return new Set([...css.matchAll(/(?:^|[}\s])\.([A-Za-z_][A-Za-z0-9_-]*)/g)]
    .map(match => match[1]!));
}

export class ClineCodingAgentAdapter implements CodingAgentPort {
  readonly adapterId = 'cline-sdk';
  private readonly maxIterations: number;
  private readonly factory: ClineAgentFactory;

  constructor(private readonly options: ClineCodingAgentOptions) {
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
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
    const newSourceIds = new Set<string>();
    let spatialScopeValidated = false;
    let introducedFixedPosition = false;
    let intentDeclared = false;
    const changedPositioningClassNames = new Set<string>();
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
      const remainingAfterThisCall = Math.max(0, this.maxIterations - context.iteration);
      const finalizationStartsAt = Math.max(1, this.maxIterations - FINALIZATION_WINDOW + 1);
      if (BUDGETED_READ_ACTIONS.has(action) && context.iteration >= finalizationStartsAt) {
        const message = `[运行预算] 当前第 ${context.iteration}/${this.maxIterations} 轮，已进入最后 ${FINALIZATION_WINDOW} 轮，停止继续读取。若修改已完成，请立即调用 validate_workspace 后 finish；若关键信息仍不足，请调用 clarify。`;
        record(action, input, context, message);
        return message;
      }
      try {
        const result = await operation();
        const guidedResult = remainingAfterThisCall <= 5
          ? `[运行预算] 当前第 ${context.iteration}/${this.maxIterations} 轮，本次后最多剩余 ${remainingAfterThisCall} 轮。请停止扩展范围，完成必要修改并预留 validate_workspace 与 finish。\n\n${result}`
          : result;
        record(action, input, context, guidedResult);
        return guidedResult;
      } catch (error) {
        const baseMessage = error instanceof Error ? error.message : String(error);
        const failureKey = `${action}:${baseMessage}`;
        const repeated = (repeatedFailures.get(failureKey) ?? 0) + 1;
        repeatedFailures.set(failureKey, repeated);
        const message = repeated >= 2
          ? `${baseMessage}。同一错误已重复 ${repeated} 次，请停止当前策略；追加内容请改用 apply_patch 的 start/end，无法安全继续则调用 clarify。`
          : baseMessage;
        record(action, input, context, undefined, message);
        if (repeated >= MAX_IDENTICAL_TOOL_FAILURES) {
          throw new Error(`${message} 已达到单个错误的重试上限（${MAX_IDENTICAL_TOOL_FAILURES} 次），请调用 clarify 或改用其他策略。`);
        }
        throw new Error(message);
      }
    };

    const trackNewSourceIds = (before: string, after: string) => {
      const existing = sourceIdsIn(before);
      let changed = false;
      for (const sourceId of sourceIdsIn(after)) {
        if (existing.has(sourceId)) continue;
        newSourceIds.add(sourceId);
        changed = true;
      }
      if (changed) spatialScopeValidated = false;
    };

    const trackPositioningChange = (before: string, after: string) => {
      if (!/\bposition\s*:\s*fixed\b/i.test(before) && /\bposition\s*:\s*fixed\b/i.test(after)) {
        introducedFixedPosition = true;
        spatialScopeValidated = false;
      }
      for (const className of cssClassNamesIn(after)) {
        changedPositioningClassNames.add(className);
      }
    };

    const trackCreatedSourceIdsFromResult = (result: string) => {
      const created = new Set<string>();
      for (const match of result.matchAll(/(?:新容器|克隆元素)\s+(source-\d+)/g)) created.add(match[1]!);
      for (const match of result.matchAll(/顶层元素：([^；\n]+)/g)) {
        for (const sourceId of match[1]!.match(/source-\d+/g) ?? []) created.add(sourceId);
      }
      if (!created.size) return;
      for (const sourceId of created) newSourceIds.add(sourceId);
      spatialScopeValidated = false;
    };

    const requireIntentDeclared = () => {
      if (!intentDeclared) {
        throw new Error('源码写入已阻止：请先读取必要上下文并调用 declare_intent；若仍有多个合理结果，请调用 clarify');
      }
    };

    const tools: AgentTool<any, any>[] = [
      createTool<{
        summary: string;
        relevantSourceIds?: string[];
        visualConstraints?: string[];
        ambiguityAssessment: string;
      }, string>({
        name: 'declare_intent',
        description: '在任何源码写入前声明模型对需求的结构化理解。仅在不存在尚未解决的关键歧义时调用；否则调用 clarify。',
        inputSchema: objectSchema({
          summary: stringProperty('准备实现的明确目标。'),
          relevantSourceIds: {
            type: 'array', maxItems: 20,
            items: stringProperty('与本次目标相关的 sourceId。')
          },
          visualConstraints: {
            type: 'array', maxItems: 20,
            items: stringProperty('修改后必须成立的视觉或结构约束。')
          },
          ambiguityAssessment: stringProperty('说明为何当前信息足以得到唯一方案；不得用来掩盖未解决歧义。')
        }, ['summary', 'ambiguityAssessment']),
        execute: (input, context) => execute(
          'declare_intent',
          input,
          context,
          async () => {
            intentDeclared = true;
            return `意图已声明：${input.summary}\n视觉约束：${input.visualConstraints?.join('；') || '无'}\n歧义判断：${input.ambiguityAssessment}`;
          }
        )
      }),
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
      createTool<{ sourceIds: string[] }, string>({
        name: 'inspect_elements',
        description: '批量读取多个 data-ui-source-id 元素的局部源码、文字和样式线索，减少重复调用。',
        inputSchema: objectSchema({
          sourceIds: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: stringProperty('元素的 data-ui-source-id。')
          }
        }, ['sourceIds']),
        execute: (input, context) => execute(
          'inspect_elements',
          input,
          context,
          async () => (await Promise.all(input.sourceIds.map(
            sourceId => workspace.inspectElement(sourceId)
          ))).join('\n\n---\n\n')
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
      createTool<{ classNames: string[] }, string>({
        name: 'read_style_rules',
        description: '批量读取多个 snapshot.css 完整样式规则，适合一次比较相关组件。',
        inputSchema: objectSchema({
          classNames: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: stringProperty('样式类名，可带或不带开头的点。')
          }
        }, ['classNames']),
        execute: (input, context) => execute(
          'read_style_rules',
          input,
          context,
          async () => (await Promise.all(input.classNames.map(
            className => workspace.readStyleRule(className)
          ))).join('\n\n---\n\n')
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
          async () => {
            requireIntentDeclared();
            const result = await workspace.replaceText(input.path, input.search, input.replace);
            if (input.path === 'index.html') trackNewSourceIds(input.search, input.replace);
            else trackPositioningChange(input.search, input.replace);
            return result;
          }
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
          async () => {
            requireIntentDeclared();
            const result = await workspace.applyPatch(input.path, input.edits);
            if (input.path === 'index.html') {
              for (const edit of input.edits) {
                if (edit.kind === 'replace') trackNewSourceIds(edit.search, edit.replace);
                else trackNewSourceIds('', edit.text);
              }
            } else {
              for (const edit of input.edits) {
                if (edit.kind === 'replace') trackPositioningChange(edit.search, edit.replace);
                else trackPositioningChange('', edit.text);
              }
            }
            return result;
          }
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
          async () => {
            requireIntentDeclared();
            const result = await workspace.replaceInElement(input.sourceId, input.search, input.replace);
            trackNewSourceIds(input.search, input.replace);
            return result;
          }
        )
      }),
      createTool<{ sourceId: string; text: string }, string>({
        name: 'set_element_text',
        description: '设置元素的完整纯文本内容；文本会安全转义，原有子元素会被移除。',
        inputSchema: objectSchema({
          sourceId: stringProperty('目标元素 sourceId。'),
          text: stringProperty('新的完整纯文本。')
        }, ['sourceId', 'text']),
        execute: (input, context) => execute('set_element_text', input, context, () => {
          requireIntentDeclared();
          return workspace.setElementText(input.sourceId, input.text);
        })
      }),
      createTool<{ sourceId: string; set?: Record<string, string>; remove?: string[] }, string>({
        name: 'set_element_attributes',
        description: '结构化设置或删除元素属性；sourceId、捕获矩形和内联 style 由系统保护。',
        inputSchema: objectSchema({
          sourceId: stringProperty('目标元素 sourceId。'),
          set: { type: 'object', additionalProperties: { type: 'string' } },
          remove: { type: 'array', maxItems: 50, items: { type: 'string' } }
        }, ['sourceId']),
        execute: (input, context) => execute('set_element_attributes', input, context, () => {
          requireIntentDeclared();
          return workspace.setElementAttributes(input.sourceId, input.set ?? {}, input.remove ?? []);
        })
      }),
      createTool<{
        targetSourceId: string;
        position: 'parentStart' | 'parentEnd' | 'before' | 'after';
        html: string;
      }, string>({
        name: 'insert_element',
        description: '在目标元素内部开头/末尾或目标前后插入静态 HTML；系统为所有新元素生成 sourceId。',
        inputSchema: objectSchema({
          targetSourceId: stringProperty('定位目标 sourceId。'),
          position: { type: 'string', enum: ['parentStart', 'parentEnd', 'before', 'after'] },
          html: stringProperty('要插入的安全静态 HTML 片段。')
        }, ['targetSourceId', 'position', 'html']),
        execute: (input, context) => execute('insert_element', input, context, async () => {
          requireIntentDeclared();
          const result = await workspace.insertElement(input.targetSourceId, input.position, input.html);
          trackCreatedSourceIdsFromResult(result);
          return result;
        })
      }),
      createTool<{ sourceId: string; tagName: string; attributes?: Record<string, string> }, string>({
        name: 'wrap_element',
        description: '用一个新容器包裹现有元素，并为容器生成 sourceId。',
        inputSchema: objectSchema({
          sourceId: stringProperty('要包裹的元素 sourceId。'),
          tagName: stringProperty('包装容器标签名。'),
          attributes: { type: 'object', additionalProperties: { type: 'string' } }
        }, ['sourceId', 'tagName']),
        execute: (input, context) => execute('wrap_element', input, context, async () => {
          requireIntentDeclared();
          const result = await workspace.wrapElement(input.sourceId, input.tagName, input.attributes ?? {});
          trackCreatedSourceIdsFromResult(result);
          return result;
        })
      }),
      createTool<{ sourceId: string }, string>({
        name: 'unwrap_element',
        description: '移除一个容器元素，但把它的原有子节点保留在原位置。',
        inputSchema: objectSchema({ sourceId: stringProperty('要解除包裹的容器 sourceId。') }, ['sourceId']),
        execute: (input, context) => execute('unwrap_element', input, context, () => {
          requireIntentDeclared();
          return workspace.unwrapElement(input.sourceId);
        })
      }),
      createTool<{ sourceId: string }, string>({
        name: 'remove_element',
        description: '按 data-ui-source-id 原子删除一个完整元素及其后代节点，并刷新结构索引。',
        inputSchema: objectSchema({
          sourceId: stringProperty('要删除的元素 data-ui-source-id。')
        }, ['sourceId']),
        execute: (input, context) => execute(
          'remove_element',
          input,
          context,
          () => {
            requireIntentDeclared();
            return workspace.removeElement(input.sourceId);
          }
        )
      }),
      createTool<{ parentSourceId: string; orderedSourceIds: string[] }, string>({
        name: 'reorder_children',
        description: '按给定顺序重排父元素的全部直接 source 子节点，不重建子树。',
        inputSchema: objectSchema({
          parentSourceId: stringProperty('父元素 sourceId。'),
          orderedSourceIds: {
            type: 'array', minItems: 1, maxItems: 200,
            items: stringProperty('直接子节点 sourceId。')
          }
        }, ['parentSourceId', 'orderedSourceIds']),
        execute: (input, context) => execute('reorder_children', input, context, () => {
          requireIntentDeclared();
          return workspace.reorderChildren(input.parentSourceId, input.orderedSourceIds);
        })
      }),
      createTool<{ operations: DomOperation[] }, string>({
        name: 'apply_dom_operations',
        description: '原子执行 1-20 项结构化 DOM 操作；任何一项失败都会回滚全部操作。',
        inputSchema: objectSchema({
          operations: {
            type: 'array', minItems: 1, maxItems: 20,
            items: z.toJSONSchema(domOperationSchema)
          }
        }, ['operations']),
        execute: (input, context) => execute('apply_dom_operations', input, context, async () => {
          requireIntentDeclared();
          const result = await workspace.applyDomOperations(input.operations);
          trackCreatedSourceIdsFromResult(result);
          return result;
        })
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
          () => {
            requireIntentDeclared();
            return workspace.moveElement(input.sourceId, input.position, input.targetSourceId);
          }
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
          async () => {
            requireIntentDeclared();
            const result = await workspace.cloneElement(
              input.templateSourceId,
              input.position,
              input.targetSourceId,
              input.replacements
            );
            const clonedSourceId = result.match(/克隆元素\s+(source-\d+)/)?.[1];
            if (clonedSourceId) {
              newSourceIds.add(clonedSourceId);
              spatialScopeValidated = false;
            }
            return result;
          }
        )
      }),
      createTool<{
        scope: 'selected-context' | 'explicit-container' | 'global';
        containerSourceId?: string;
        createdSourceIds: string[];
        positioningClassNames?: string[];
        reason: string;
      }, string>({
        name: 'validate_spatial_scope',
        description: '校验新增模块是否围绕选区或用户明确指定的容器定位。新增元素后、finish 前必须调用。',
        inputSchema: objectSchema({
          scope: { type: 'string', enum: ['selected-context', 'explicit-container', 'global'] },
          containerSourceId: stringProperty('实际承载新增顶层模块的容器 sourceId；global 可省略。'),
          createdSourceIds: {
            type: 'array', minItems: 1, maxItems: 20,
            items: stringProperty('本轮新增的顶层模块 sourceId。')
          },
          positioningClassNames: {
            type: 'array', maxItems: 20,
            items: stringProperty('控制新增模块定位的 CSS 类名。')
          },
          reason: stringProperty('为何选择该容器，以及它与用户位置描述或选区的关系。')
        }, ['scope', 'createdSourceIds', 'reason']),
        execute: (input, context) => execute(
          'validate_spatial_scope',
          input,
          context,
          async () => {
            const selectedSourceId = turn.request.sourceId;
            if (input.scope === 'global' && !hasExplicitGlobalPlacement(turn.request.instruction)) {
              throw new Error('用户没有明确指定页面、浏览器视口、全局、悬浮或固定位置，禁止使用 global 定位；请围绕当前选区选择语义容器，无法判断则 clarify');
            }
            if (input.scope !== 'global') {
              if (!input.containerSourceId) throw new Error('非全局定位必须提供 containerSourceId');
              if (input.scope === 'selected-context' && selectedSourceId) {
                const selectedPath = ancestrySourceIds(await workspace.inspectElement(selectedSourceId));
                if (!selectedPath.includes(input.containerSourceId)) {
                  throw new Error(`容器 ${input.containerSourceId} 不在选中元素 ${selectedSourceId} 的祖先路径中；请使用选区语义祖先或最近公共父容器`);
                }
              }
              for (const sourceId of newSourceIds) {
                const createdPath = ancestrySourceIds(await workspace.inspectElement(sourceId));
                if (!createdPath.includes(input.containerSourceId)) {
                  throw new Error(`新增元素 ${sourceId} 不在声明的容器 ${input.containerSourceId} 内`);
                }
              }
            }
            if (input.scope !== 'global') {
              if (introducedFixedPosition) {
                throw new Error('本轮新增样式包含 position:fixed，但用户没有明确要求页面、浏览器视口或全局固定定位；请改为选区容器内的普通、absolute 或 sticky 布局');
              }
              for (const className of input.positioningClassNames ?? []) {
                const normalizedClassName = className.replace(/^\./, '');
                // readStyleRule may return a pre-existing snapshot rule. Only treat
                // fixed positioning as a new violation when this turn actually
                // changed or created that CSS class.
                if (!changedPositioningClassNames.has(normalizedClassName)) continue;
                const rule = await workspace.readStyleRule(className);
                if (/\bposition\s*:\s*fixed\b/i.test(rule)) {
                  throw new Error(`样式 .${className.replace(/^\./, '')} 使用了 position:fixed，但用户没有声明全局视口定位`);
                }
              }
            }
            spatialScopeValidated = true;
            return `空间归属校验通过：scope=${input.scope}${input.containerSourceId ? `，container=${input.containerSourceId}` : ''}；${input.reason}`;
          }
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
            requireIntentDeclared();
            if (introducedFixedPosition && !hasExplicitGlobalPlacement(turn.request.instruction)) {
              throw new Error('用户没有明确要求全局定位，本轮却新增了 position:fixed；请围绕当前选区或其语义容器重新定位');
            }
            if (newSourceIds.size > 0 && !spatialScopeValidated) {
              throw new Error(`本轮新增了 ${newSourceIds.size} 个源码元素，finish 前必须调用 validate_spatial_scope 校验其参照容器`);
            }
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
      createTool<ClarifyToolInput, string>({
        name: 'clarify',
        description: '存在会显著影响结果的关键歧义时，回滚本轮并向用户提出一个具体问题；尽量提供互斥选项。',
        inputSchema: objectSchema({
          question: stringProperty('需要用户补充的具体信息。'),
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            description: '可选的 2-4 个互斥方案。',
            items: objectSchema({
              id: stringProperty('稳定、简短的选项标识。'),
              label: stringProperty('面向用户的简短选项名称。'),
              description: stringProperty('该方案的具体影响或差异。')
            }, ['id', 'label'])
          },
          allowFreeText: {
            type: 'boolean',
            description: '是否允许用户不用选项、直接自由输入；默认允许。'
          }
        }, ['question']),
        lifecycle: { completesRun: true },
        execute: async (input, context) => {
          await rollback();
          completion = {
            kind: 'clarification',
            question: input.question,
            ...(input.options && { options: input.options }),
            allowFreeText: input.options ? input.allowFreeText ?? true : true
          };
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
        systemPrompt: `${clineSourceRules}\n单轮最多 ${this.maxIterations} 次模型决策；从第 ${Math.max(1, this.maxIterations - FINALIZATION_WINDOW + 1)} 轮起必须停止扩展读取，只能完成必要修改、校验并 finish，或 clarify。`,
        tools,
        maxIterations: this.maxIterations
      });
      const result = await agent.run(JSON.stringify({
        instruction: turn.request.instruction,
        selectedSourceId: turn.request.sourceId,
        replyToClarificationId: turn.request.replyToClarificationId,
        clarificationOptionId: turn.request.clarificationOptionId,
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
        response = {
          kind: 'clarification',
          clarificationId: turn.request.turnId,
          question: completion.question,
          ...(completion.options && { options: completion.options }),
          allowFreeText: completion.allowFreeText
        };
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
    throw new Error('Cline SDK 运行时必须设置 MODEL_MODE=remote');
  }
  if (!env.MODEL_BASE_URL || !env.MODEL_API_KEY || !env.MODEL_NAME) {
    throw new Error('Cline Adapter 必须设置 MODEL_BASE_URL、MODEL_API_KEY 和 MODEL_NAME');
  }
  const parsedMaxIterations = Number(env.CLINE_MAX_ITERATIONS ?? DEFAULT_MAX_ITERATIONS);
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
