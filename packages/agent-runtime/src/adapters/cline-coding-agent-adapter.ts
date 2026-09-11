import {
  Agent,
  createTool,
  type AgentRunResult,
  type AgentTool,
  type AgentToolContext
} from '../../vendor/ui-agent-runtime/index.js';
import { randomUUID } from 'node:crypto';
import {
  domOperationSchema,
  modelCallProgressSchema,
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
  type CodingWorkspaceTools,
  type GeometryVerificationInput,
  type GeometryVerificationResult
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
  '你是静态网页源码编辑 Agent，只使用本次提供的源码工具。页面用于 UI 示意，不实现真实接口或业务提交。',
  '输入已包含文件摘要；有 selectedElementContext 时直接使用，无需重复枚举文件、搜索或检查同一选中元素。没有目标上下文时先 query_workspace_structure，再按需 inspect_element。取得足够证据后立即修改，不要为了寻找更理想的 class、变量或示例继续扩展搜索。',
  'index.html 保存结构和文案。存在 author.css 或 author-style-links.json 时，视觉修改只写 author-overrides.css，author.css 仅供查询，snapshot.css 不可修改；否则视觉修改写 snapshot.css。outline.json 和 source-map.json 只读。',
  'inspect_element 默认返回目标、祖先、同级、布局、局部源码、目标实际命中的样式规则，以及可识别时的组件库规范；只有缺少完成当前修改的具体信息时才使用 full。已有组件与样式上下文时直接据此修改，不要再次搜索组件基础样式；仅在明确缺少某条页面覆盖规则时使用 query_style_symbols，避免全文搜索大 CSS。',
  '目标明确的单元素文案、属性或已有组件形态转换，应使用 selectedElementContext 在前两次模型决策内完成意图声明并开始写入；不要为了比较未被用户要求的视觉方案检索相邻示例。',
  '修改前只需确认目标、最近相关容器和必要的相邻元素。新增同类组件优先复用现有结构和 class；没有合适结构时再增加局部 HTML/CSS。修改行内样式时注意级联优先级，背景也可能由子元素或伪元素绘制。',
  '位置描述以用户明确容器为准，否则以 selectedSourceId 或最近语义祖先为锚点。相邻组件只扩展到最近公共父容器；用户未明确要求全局视口定位时不得新增 position:fixed。新增元素后调用 validate_spatial_scope。',
  '若多个方案会显著改变最终视觉结果，修改前调用 clarify；问题只询问源码无法确定的信息。已有澄清回复时结合 conversation 继续原需求。',
  '首次写入前调用一次 declare_intent，简洁列出目标、相关 sourceId、需要浏览器验证的约束和布局范围。新增 sourceId 会由系统自动加入验证范围。',
  '文本、属性、插入、移动、删除和批量操作使用对应结构化工具；精确替换必须基于已读取原文，追加 CSS 使用 apply_patch。相关修改尽量在同一轮并行调用或用批量工具完成。',
  '不得添加 script、事件属性、远程资源、接口请求、表单 action 或 javascript: URL。',
  CONTROLLED_INTERACTION_INSTRUCTIONS,
  '修改完成后直接调用 finish；finish 会执行工作区校验。新增元素仍须先完成空间归属校验。源码和捕获布局不能证明真实渲染结果，不得声称已经通过浏览器验证。无需修改时提供源码证据并使用 already_satisfied。',
  '没有调用 finish 或 clarify，本轮不算完成。保持推理和工具说明简洁，不做无关重构。'
].join('\n');

const DEFAULT_MAX_ITERATIONS = 45;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MAX_BATCH_INSPECTION_CHARS = 12_000;
const MAX_BATCH_ELEMENT_CHARS = 4_000;
const MAX_PRE_MUTATION_READS_WITH_SELECTED_CONTEXT = 4;
const FINALIZATION_WINDOW = 3;
const MAX_IDENTICAL_TOOL_FAILURES = 3;
const MAX_READ_CALLS_PER_ACTION: Readonly<Record<string, number>> = {
  query_workspace_structure: 2,
  search_text: 4,
  inspect_element: 3,
  inspect_elements: 3,
  query_style_symbols: 3,
  read_style_rule: 2,
  read_style_rules: 2,
  read_file: 3
};
const BUDGETED_READ_ACTIONS = new Set([
  'query_workspace_structure', 'search_text', 'read_file', 'inspect_element', 'inspect_elements',
  'query_style_symbols', 'read_style_rule', 'read_style_rules'
]);
const MUTATING_ACTIONS = new Set([
  'replace_text', 'apply_patch', 'replace_in_element', 'set_element_text', 'set_element_attributes',
  'insert_element', 'wrap_element', 'unwrap_element', 'remove_element', 'reorder_children',
  'apply_dom_operations', 'move_element', 'clone_element'
]);

function repeatedFailureGuidance(action: string, message: string): string {
  if (message.startsWith('受控交互校验发现')) {
    return '请按编号一次修正所有控件自身的交互属性，不要通过更换写入工具绕过校验；无法确定交互结构时调用 clarify';
  }
  if (action === 'validate_spatial_scope') {
    return '请使用错误中列出的当前源码 sourceId 重新校验容器与新增元素，不要继续引用已删除或失效的 sourceId';
  }
  return '请停止当前策略；追加内容可改用 apply_patch 的 start/end，无法安全继续则调用 clarify';
}

export interface ClineAgentInstance {
  subscribe?(listener: (event: import('../../vendor/ui-agent-runtime/index.js').AgentRuntimeEvent) => void): () => void;
  run(input: string): Promise<AgentRunResult>;
  abort?(reason?: unknown): void;
}

export interface ClineAgentFactoryInput {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  systemPrompt: string;
  tools: readonly AgentTool<any, any>[];
  maxIterations: number;
  maxOutputTokens: number;
}

export type ClineAgentFactory = (input: ClineAgentFactoryInput) => ClineAgentInstance;

export interface ClineCodingAgentOptions {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  maxIterations?: number;
  maxOutputTokens?: number;
  factory?: ClineAgentFactory;
}

type Completion =
  | {
      kind: 'completed';
      summary: string;
      validation: string;
      revision: number;
      unchanged: boolean;
    }
  | {
      kind: 'draft';
      summary: string;
      validation: string;
      candidate: import('@ui-agent/contracts').WorkspaceCandidate;
      intent: import('@ui-agent/contracts').WorkspaceIntent;
    }
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

class CodingAgentCancelledError extends Error {
  constructor() {
    super('用户已停止本轮修改');
    this.name = 'CodingAgentCancelledError';
  }
}

function safeEmit(observe: CodingAgentObserver | undefined, event: Parameters<CodingAgentObserver>[0]): void {
  try {
    observe?.(event);
  } catch {
    // Telemetry must never alter the outcome of an editing turn.
  }
}

function failedResponse(error: unknown): SourceTurnResponse {
  const value = error as Error & { statusCode?: number; code?: string };
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : Number.isInteger(value?.statusCode)
      ? `模型服务请求失败（HTTP ${value.statusCode}）`
      : typeof value?.code === 'string' && value.code
        ? `源码 Agent 执行失败（${value.code}）`
        : 'Cline 源码 Agent 执行失败';
  return {
    kind: 'failed',
    code: 'CLINE_AGENT_ERROR',
    message
  };
}

function sourceIdsIn(value: string): Set<string> {
  return new Set([...value.matchAll(/\bdata-ui-source-id\s*=\s*["'](source-\d+)["']/gi)]
    .map(match => match[1]!));
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
  private readonly maxOutputTokens: number;
  private readonly factory: ClineAgentFactory;

  constructor(private readonly options: ClineCodingAgentOptions) {
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.factory = options.factory ?? (input => new Agent({
      providerId: input.providerId,
      modelId: input.modelId,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      maxIterations: input.maxIterations,
      maxOutputTokens: input.maxOutputTokens,
      toolExecution: 'sequential',
      completionPolicy: { requireCompletionTool: true }
    }));
  }

  async verifyGeometry(input: GeometryVerificationInput, signal?: AbortSignal): Promise<GeometryVerificationResult> {
    if (signal?.aborted) throw new CodingAgentCancelledError();
    const expectedIds = [
      ...input.intent.sourceIds.map(sourceId => `source:${sourceId}`),
      ...input.intent.renderConstraintIndexes.map(index => `constraint:${index}`)
    ];
    let completion: GeometryVerificationResult | undefined;
    const validator = this.factory({
      providerId: 'openai-compatible',
      modelId: this.options.modelName,
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
      maxIterations: 4,
      maxOutputTokens: this.maxOutputTokens,
      systemPrompt: [
        '你是网页副本的几何与样式验证器。只能根据调用中提供的结构化需求、真实浏览器几何、计算样式和就绪状态作出结论。',
        '颜色或背景约束必须检查对应绘制元素的 styles.backgroundColor/backgroundImage/color 等实际计算值，不能以尺寸正确、元素存在或源码已写入代替。透明背景不能证明子元素或伪元素的背景颜色；缺少绘制元素数据时返回 unknown。旧插件未提供样式字段时也返回 unknown。',
        '当前模型没有图片输入。不得声称看过截图，也不得把截图、DOM 字符串或源码存在当成视觉通过。',
        '逐一判断每个 source 和被标为可渲染验证的 constraint。source 项可以通过“目标按需求已删除”；缺失的元素本身不是失败。未列入 renderConstraintIndexes 的约束是修改范围说明，不要为它们生成检查结果。',
        '若几何数据不足以证明某项，标记 unknown；若可证伪则标记 failed。不要猜测页面未提供的层级、样式或位置。',
        '完成时必须调用 finish_geometry_validation，给出所有要求的 id，不能调用其他工具。'
      ].join('\n'),
      tools: [createTool<{
        results: Array<{ id: string; status: 'passed' | 'failed' | 'unknown'; message: string }>;
        warnings?: string[];
      }, string>({
        name: 'finish_geometry_validation',
        description: '提交每项目标和约束的几何验证结论。',
        inputSchema: objectSchema({
          results: {
            type: 'array', minItems: expectedIds.length, maxItems: expectedIds.length,
            items: objectSchema({
              id: stringProperty(`必须为以下之一：${expectedIds.join('、')}`),
              status: { type: 'string', enum: ['passed', 'failed', 'unknown'] },
              message: stringProperty('引用提供的几何事实说明结论。')
            }, ['id', 'status', 'message'])
          },
          warnings: { type: 'array', maxItems: 20, items: stringProperty('不影响逐项结论但应保留的证据边界。') }
        }, ['results']),
        lifecycle: { completesRun: true },
        execute: async value => {
          const seen = new Set<string>();
          for (const result of value.results) {
            if (!expectedIds.includes(result.id) || seen.has(result.id)) {
              throw new Error('验证结果包含未知或重复的检查 id');
            }
            seen.add(result.id);
          }
          if (seen.size !== expectedIds.length) throw new Error('验证结果没有覆盖全部目标和约束');
          completion = {
            constraintResults: value.results.map(result => ({
              id: result.id,
              required: true,
              status: result.status,
              message: result.message.slice(0, 2_000),
              observationId: input.observation.observationId
            })),
            warnings: (value.warnings ?? []).map(warning => warning.slice(0, 2_000))
          };
          return '几何验证结果已记录';
        }
      })],
    });
    const abort = () => validator.abort?.(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await validator.run(JSON.stringify({
        intent: input.intent,
        document: {
          baseRevision: input.candidate.baseRevision,
          candidateVersion: input.candidate.candidateVersion,
          renderMode: input.candidate.renderMode
        },
        observation: input.observation.observation
      }));
      if (signal?.aborted) throw new CodingAgentCancelledError();
      if (!completion) throw new Error(
        result.error instanceof Error ? result.error.message : result.error ?? '几何验证模型未提交结构化结论'
      );
      return completion;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async run(
    turn: CodingAgentTurn,
    workspace: CodingWorkspaceTools,
    observe?: CodingAgentObserver,
    signal?: AbortSignal
  ): Promise<CodingAgentRunResult> {
    const finishDescription = workspace.submissionMode === 'candidate'
      ? 'finish 校验并物化候选草稿，不发布正式 Revision；服务随后执行真实渲染验证。'
      : 'finish 校验并直接提交正式 Revision；当前未启用自动渲染验证，实际页面效果由用户检查，不得声称正在等待自动渲染验证。';
    const modeRules = clineSourceRules;
    const startedAt = new Date().toISOString();
    const steps: CodingAgentStep[] = [];
    let completion: Completion | undefined;
    // Clarification is a hard execution boundary. Compatible runtimes may
    // continue dispatching tool calls after a lifecycle tool returns, so the
    // adapter must enforce the boundary independently of the model/runtime.
    let clarificationRequested = false;
    let rolledBack = false;
    let rollbackStatus: 'not_requested' | 'succeeded' | 'failed' = 'not_requested';
    const newSourceIds = new Set<string>();
    let spatialScopeValidated = false;
    let introducedFixedPosition = false;
    let intentDeclared = false;
    let declaredIntent: import('@ui-agent/contracts').WorkspaceIntent | undefined;
    const changedPositioningClassNames = new Set<string>();
    const repeatedFailures = new Map<string, number>();
    const readActionCounts = new Map<string, number>();
    let selectedElementContextAvailable = false;
    let firstMutationAt: string | undefined;
    let firstMutationModelCall: number | undefined;
    let preMutationReadCalls = 0;
    let activeAgent: ClineAgentInstance | undefined;
    const throwIfCancelled = () => {
      if (signal?.aborted) throw new CodingAgentCancelledError();
    };
    const abortActiveAgent = () => activeAgent?.abort?.(signal?.reason);
    signal?.addEventListener('abort', abortActiveAgent, { once: true });
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
      if (rolledBack || completion?.kind === 'completed' || completion?.kind === 'draft') return;
      rolledBack = true;
      try {
        await workspace.rollback();
        rollbackStatus = 'succeeded';
      } catch (error) {
        rollbackStatus = 'failed';
        throw error;
      }
    };

    const record = (
      action: string,
      input: unknown,
      context: AgentToolContext,
      result?: string,
      error?: string,
      countAsTool = true,
      outcome?: 'blocked'
    ) => {
      const timestamp = new Date().toISOString();
      const step: CodingAgentStep = {
        timestamp,
        toolCallId: context.toolCallId,
        outcome: error ? 'failed' : outcome ?? 'succeeded',
        ...(result !== undefined ? { resultChars: result.length, resultTruncated: result.length > 16_000 } : {}),
        modelCall: context.iteration,
        action,
        input,
        ...(result ? { result: result.slice(0, 16_000) } : {}),
        ...(error ? { error } : {})
      };
      steps.push(step);
      if (outcome === 'blocked') context.emitUpdate?.({ type: 'tool-outcome', outcome });
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

    const completedReadResults = new Map<string, string>();

    const execute = async <TInput>(
      action: string,
      input: TInput,
      context: AgentToolContext,
      operation: () => Promise<string>
    ): Promise<string> => {
      throwIfCancelled();
      if (clarificationRequested || completion?.kind === 'clarification') {
        throw new Error('本轮已进入等待用户澄清状态，禁止继续读取、修改或提交；请等待用户回复后开启新一轮执行');
      }
      const remainingAfterThisCall = Math.max(0, this.maxIterations - context.iteration);
      const finalizationStartsAt = Math.max(1, this.maxIterations - FINALIZATION_WINDOW + 1);
      if (BUDGETED_READ_ACTIONS.has(action) && !['inspect_element', 'inspect_elements'].includes(action)
        && context.iteration >= finalizationStartsAt) {
        const message = `[运行预算] 当前第 ${context.iteration}/${this.maxIterations} 轮，已进入最后 ${FINALIZATION_WINDOW} 轮，停止继续读取。若修改已完成，请立即调用 finish；若关键信息仍不足，请调用 clarify。`;
        record(action, input, context, message, undefined, true, 'blocked');
        return message;
      }
      const readKey = BUDGETED_READ_ACTIONS.has(action)
        ? `${action}:${JSON.stringify(input)}`
        : undefined;
      const budgetKey = action === 'search_text' || action === 'read_file'
        ? `${action}:${(input as { path?: string }).path ?? ''}`
        : action;
      const actionLimit = MAX_READ_CALLS_PER_ACTION[action];
      if (BUDGETED_READ_ACTIONS.has(action) && selectedElementContextAvailable && !firstMutationAt
        && preMutationReadCalls >= MAX_PRE_MUTATION_READS_WITH_SELECTED_CONTEXT) {
        const message = `[修改前读取预算] 已有 selectedElementContext，且修改前已补充读取 ${preMutationReadCalls} 次。请使用现有结构、组件规范和局部样式证据立即修改；若仍缺少会显著影响结果的信息，请调用 clarify。`;
        record(action, input, context, message, undefined, true, 'blocked');
        return message;
      }
      if (readKey && completedReadResults.has(readKey)) {
        const message = '[重复读取已拦截] 当前源码版本的相同查询已经返回，请使用已有证据；修改源码后可重新检查。';
        record(action, input, context, message, undefined, true, 'blocked');
        return message;
      }
      if (actionLimit) {
        const actionCount = (readActionCounts.get(budgetKey) ?? 0) + 1;
        readActionCounts.set(budgetKey, actionCount);
        if (actionCount > actionLimit) {
          const message = `[读取预算] ${action} 已调用 ${actionCount} 次，超过本轮上限 ${actionLimit} 次。请停止继续检索，使用已有上下文完成修改和校验；若信息不足则调用 clarify。`;
          record(action, input, context, message, undefined, true, 'blocked');
          return message;
        }
      }
      try {
        const result = await operation();
        if (BUDGETED_READ_ACTIONS.has(action) && !firstMutationAt) preMutationReadCalls += 1;
        if (MUTATING_ACTIONS.has(action)) {
          if (!firstMutationAt) {
            firstMutationAt = new Date().toISOString();
            firstMutationModelCall = context.iteration;
          }
          completedReadResults.clear();
          readActionCounts.clear();
          repeatedFailures.clear();
          if (newSourceIds.size > 0) spatialScopeValidated = false;
        }
        if (readKey) completedReadResults.set(readKey, result);
        throwIfCancelled();
        const guidedResult = remainingAfterThisCall <= 5
          ? `[运行预算] 当前第 ${context.iteration}/${this.maxIterations} 轮，本次后最多剩余 ${remainingAfterThisCall} 轮。请停止扩展范围，完成必要修改并预留 finish。\n\n${result}`
          : result;
        record(action, input, context, guidedResult);
        return guidedResult;
      } catch (error) {
        const baseMessage = error instanceof Error ? error.message : String(error);
        const failureKey = `${action}:${baseMessage}`;
        const repeated = (repeatedFailures.get(failureKey) ?? 0) + 1;
        repeatedFailures.set(failureKey, repeated);
        const message = repeated >= 2
          ? `${baseMessage}。同一错误已重复 ${repeated} 次，${repeatedFailureGuidance(action, baseMessage)}。`
          : baseMessage;
        record(action, input, context, undefined, message);
        if (repeated >= MAX_IDENTICAL_TOOL_FAILURES) {
          throw Object.assign(
            new Error(`${message} 已达到单个错误的重试上限（${MAX_IDENTICAL_TOOL_FAILURES} 次），已停止本轮修改以避免继续空转。`),
            { terminalToolError: true }
          );
        }
        throw new Error(message);
      }
    };

    const registerNewSourceId = (sourceId: string) => {
      newSourceIds.add(sourceId);
      if (declaredIntent && !declaredIntent.sourceIds.includes(sourceId)) {
        declaredIntent = { ...declaredIntent, sourceIds: [...declaredIntent.sourceIds, sourceId] };
      }
    };

    const forgetNewSourceId = (sourceId: string) => {
      if (!newSourceIds.delete(sourceId)) return;
      if (declaredIntent) {
        declaredIntent = {
          ...declaredIntent,
          sourceIds: declaredIntent.sourceIds.filter(candidate => candidate !== sourceId)
        };
      }
    };

    const trackSourceIdChanges = (before: string, after: string) => {
      const existing = sourceIdsIn(before);
      const replacement = sourceIdsIn(after);
      let changed = false;
      for (const sourceId of replacement) {
        if (existing.has(sourceId)) continue;
        registerNewSourceId(sourceId);
        changed = true;
      }
      for (const sourceId of existing) {
        if (replacement.has(sourceId) || !newSourceIds.has(sourceId)) continue;
        forgetNewSourceId(sourceId);
        changed = true;
      }
      if (changed) spatialScopeValidated = false;
    };

    const reconcileNewSourceIds = async () => {
      const removed: string[] = [];
      for (const sourceId of [...newSourceIds]) {
        try {
          await workspace.inspectElement(sourceId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes(`源码中不存在元素 ${sourceId}`)) throw error;
          forgetNewSourceId(sourceId);
          removed.push(sourceId);
        }
      }
      return removed;
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
      for (const sourceId of created) registerNewSourceId(sourceId);
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
        verificationSourceIds?: string[];
        visualConstraints?: string[];
        renderConstraintIndexes?: number[];
        layoutScope?: 'selected-context' | 'explicit-container' | 'global';
      }, string>({
        name: 'declare_intent',
        description: '首次写入前简洁声明目标和浏览器需要验证的事实；有关键歧义时改用 clarify。',
        inputSchema: objectSchema({
          summary: stringProperty('准备实现的明确目标。'),
          relevantSourceIds: {
            type: 'array', maxItems: 12,
            items: stringProperty('与本次目标相关的 sourceId。')
          },
          verificationSourceIds: {
            type: 'array', maxItems: 16,
            items: stringProperty('真实浏览器需要测量的已有 sourceId。')
          },
          visualConstraints: {
            type: 'array', maxItems: 12,
            items: stringProperty('需要浏览器验证的简洁视觉或结构约束。')
          },
          renderConstraintIndexes: {
            type: 'array', maxItems: 12,
            items: { type: 'integer', minimum: 1 },
            description: 'visualConstraints 中可由浏览器几何或计算样式验证的序号；省略时默认验证第一项。'
          },
          layoutScope: { type: 'string', enum: ['selected-context', 'explicit-container', 'global'] }
        }, ['summary']),
        execute: (input, context) => execute(
          'declare_intent',
          input,
          context,
          async () => {
            const sourceIds = [...new Set([
              ...(turn.request.sourceId ? [turn.request.sourceId] : []),
              ...(input.relevantSourceIds ?? []),
              ...(input.verificationSourceIds ?? [])
            ])];
            const constraints = [...new Set(input.visualConstraints?.length ? input.visualConstraints : [input.summary])];
            const renderConstraintIndexes = [...new Set(input.renderConstraintIndexes?.length ? input.renderConstraintIndexes : [1])];
            if (!sourceIds.length) {
              throw new Error('declare_intent 必须列出至少一个实际相关的 sourceId；请先查询并检查目标结构，无法定位时调用 clarify');
            }
            if (renderConstraintIndexes.some(index => index < 1 || index > constraints.length)) {
              throw new Error('renderConstraintIndexes 必须引用 visualConstraints 中存在的序号');
            }
            intentDeclared = true;
            declaredIntent = {
              intentId: randomUUID(),
              version: 0,
              instruction: turn.request.instruction,
              sourceIds,
              constraints,
              renderConstraintIndexes,
              layoutScope: input.layoutScope ?? 'selected-context',
              createdAt: new Date().toISOString()
            };
            return `意图已声明：${input.summary}`;
          }
        )
      }),
      createTool<{ query: string; selectedSourceId?: string; limit?: number }, string>({
        name: 'query_workspace_structure',
        description: '在系统维护的页面结构索引中按语义查询候选元素及其父子、同级关系。优先用于定位需求涉及的区域、行、状态和控件，避免反复全文搜索大源码文件。',
        inputSchema: objectSchema({
          query: stringProperty('从用户需求中提炼的关键语义词，可包含多个词。'),
          selectedSourceId: stringProperty('可选：当前选中元素，用于优先返回其附近的结构。'),
          limit: { type: 'integer', minimum: 1, maximum: 12 }
        }, ['query']),
        execute: (input, context) => execute(
          'query_workspace_structure',
          input,
          context,
          () => workspace.queryWorkspaceStructure(input.query, {
            selectedSourceId: input.selectedSourceId ?? turn.request.sourceId,
            limit: input.limit
          })
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
      createTool<{ sourceId: string; detail?: 'compact' | 'full' }, string>({
        name: 'inspect_element',
        description: '按 data-ui-source-id 读取页面元素的局部源码、文字和样式线索。默认 compact，信息不足时可直接使用 full。',
        inputSchema: objectSchema({
          sourceId: stringProperty('元素的 data-ui-source-id。'),
          detail: { type: 'string', enum: ['compact', 'full'] }
        }, ['sourceId']),
        execute: (input, context) => execute(
          'inspect_element', input, context,
          () => workspace.inspectElement(input.sourceId, { detail: input.detail ?? 'compact' })
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
          async () => {
            const sections = await Promise.all(input.sourceIds.map(async sourceId => {
              const result = await workspace.inspectElement(sourceId, { detail: 'compact' });
              return `元素 ${sourceId}\n${result.slice(0, MAX_BATCH_ELEMENT_CHARS)}`;
            }));
            const combined = sections.join('\n\n---\n\n');
            return combined.length <= MAX_BATCH_INSPECTION_CHARS
              ? combined
              : `[批量检查已按总预算截断] 原始 ${combined.length} 字符，仅返回前 ${MAX_BATCH_INSPECTION_CHARS} 字符。请只对确实缺少证据的单个元素补查。\n\n${combined.slice(0, MAX_BATCH_INSPECTION_CHARS)}`;
          }
        )
      }),
      createTool<{ symbols: string[] }, string>({
        name: 'query_style_symbols',
        description: '结构化查询 class 或 CSS 自定义属性，返回有总预算的相关规则/片段；优先于全文搜索 author.css。',
        inputSchema: objectSchema({
          symbols: {
            type: 'array', minItems: 1, maxItems: 12,
            items: stringProperty('class 名（可带点）或以 -- 开头的 CSS 自定义属性。')
          }
        }, ['symbols']),
        execute: (input, context) => execute(
          'query_style_symbols', input, context, () => workspace.queryStyleSymbols(input.symbols)
        )
      }),
      createTool<{ className: string }, string>({
        name: 'read_style_rule',
        description: '冻结模式下按 inspect_element 返回的 class 名读取 snapshot.css 中对应的完整样式规则。原始规则模式请检索只读 author.css。',
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
          path: stringProperty('只允许 index.html，以及当前模式的样式文件：原始规则模式为 author-overrides.css，冻结模式为 snapshot.css。'),
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
            if (input.path === 'index.html') trackSourceIdChanges(input.search, input.replace);
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
          path: stringProperty('只允许 index.html，以及当前模式的样式文件：原始规则模式为 author-overrides.css，冻结模式为 snapshot.css。'),
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
                if (edit.kind === 'replace') trackSourceIdChanges(edit.search, edit.replace);
                else trackSourceIdChanges('', edit.text);
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
            trackSourceIdChanges(input.search, input.replace);
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
        styleReferenceSourceId?: string;
      }, string>({
        name: 'insert_element',
        description: '在目标元素内部开头/末尾或目标前后插入静态 HTML；系统为所有新元素生成 sourceId。可选提供已检查的同类元素作为冻结计算样式参照。',
        inputSchema: objectSchema({
          targetSourceId: stringProperty('定位目标 sourceId。'),
          position: { type: 'string', enum: ['parentStart', 'parentEnd', 'before', 'after'] },
          html: stringProperty('要插入的安全静态 HTML 片段。'),
          styleReferenceSourceId: stringProperty('可选：已检查的相邻同类元素。系统会将其冻结计算样式复制给新增顶层元素，用于保持尺寸、间距和对齐。')
        }, ['targetSourceId', 'position', 'html']),
        execute: (input, context) => execute('insert_element', input, context, async () => {
          requireIntentDeclared();
          const result = await workspace.insertElement(input.targetSourceId, input.position, input.html, {
            styleReferenceSourceId: input.styleReferenceSourceId
          });
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
        replacements?: Array<{ search: string; replace: string }>;
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
        }, ['templateSourceId', 'position']),
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
              input.replacements ?? []
            );
            const clonedSourceId = result.match(/克隆元素\s+(source-\d+)/)?.[1];
            if (clonedSourceId) {
              registerNewSourceId(clonedSourceId);
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
            const removedSourceIds = await reconcileNewSourceIds();
            const activeSourceIds = new Set(newSourceIds);
            const omittedSourceIds = [...activeSourceIds].filter(sourceId => !input.createdSourceIds.includes(sourceId));
            if (omittedSourceIds.length) {
              throw new Error(`createdSourceIds 遗漏了仍存在的本轮新增元素：${omittedSourceIds.join(', ')}`);
            }
            const selectedSourceId = turn.request.sourceId;
            if (input.scope === 'global' && declaredIntent?.layoutScope !== 'global') {
              throw new Error('当前已确认意图没有声明 global 布局范围；请围绕已确认容器定位，或在修改前 clarify');
            }
            if (input.scope !== 'global') {
              if (!input.containerSourceId) throw new Error('非全局定位必须提供 containerSourceId');
              if (input.scope === 'selected-context' && selectedSourceId) {
                const selectedPath = ancestrySourceIds(await workspace.inspectElement(selectedSourceId));
                if (!selectedPath.includes(input.containerSourceId)) {
                  throw new Error(`容器 ${input.containerSourceId} 不在选中元素 ${selectedSourceId} 的祖先路径中；请使用选区语义祖先或最近公共父容器`);
                }
              }
              for (const sourceId of activeSourceIds) {
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
            return `空间归属校验通过：scope=${input.scope}${input.containerSourceId ? `，container=${input.containerSourceId}` : ''}${removedSourceIds.length ? `；已忽略本轮随后删除的元素 ${removedSourceIds.join(', ')}` : ''}；${input.reason}`;
          }
        )
      }),
      createTool<{
        summary: string;
        outcome?: 'changed' | 'already_satisfied';
        evidence?: string;
      }, string>({
        name: 'finish',
        description: `${finishDescription}若当前副本无需改动，设置 outcome=already_satisfied，并提供源码证据。`,
        inputSchema: objectSchema({
          summary: stringProperty('面向用户的简洁修改说明。'),
          outcome: {
            type: 'string',
            enum: ['changed', 'already_satisfied'],
            description: '本轮是否产生了源码修改；默认 changed。'
          },
          evidence: stringProperty('仅 outcome=already_satisfied 时填写：说明已读取和验证的当前源码证据。')
        }, ['summary']),
        lifecycle: { completesRun: true },
        execute: async (input, context) => {
          try {
            throwIfCancelled();
            if (clarificationRequested || completion?.kind === 'clarification') {
              throw new Error('本轮已进入等待用户澄清状态，禁止提交；请等待用户回复后开启新一轮执行');
            }
            requireIntentDeclared();
            if (introducedFixedPosition && declaredIntent?.layoutScope !== 'global') {
              throw new Error('当前已确认意图不是 global 布局范围，本轮却新增了 position:fixed；请调整到已确认容器内');
            }
            if (newSourceIds.size > 0 && !spatialScopeValidated) {
              throw new Error(`本轮新增了 ${newSourceIds.size} 个源码元素，finish 前必须调用 validate_spatial_scope 校验其参照容器`);
            }
            const validation = await workspace.validate();
            const commit = await workspace.commit(input.summary, {
              allowNoChanges: input.outcome === 'already_satisfied' && Boolean(input.evidence?.trim())
            });
            if (!commit.changed && input.outcome !== 'already_satisfied') {
              throw new Error('当前副本没有新增源码修改；仅在确认目标已满足时，才能以 outcome=already_satisfied 结束本轮');
            }
            const summary = commit.changed
              ? input.summary
              : `当前副本已满足该需求，无需重复修改。${input.summary}`;
            if (commit.candidate && !declaredIntent) throw new Error('候选草稿缺少已确认的结构化意图，拒绝进入渲染验证');
            completion = commit.candidate
              ? { kind: 'draft', summary, validation, candidate: commit.candidate, intent: declaredIntent! }
              : { kind: 'completed', summary, validation, revision: commit.revision, unchanged: !commit.changed };
            const result = `${summary}（${validation}；revision=${commit.revision}${commit.changed ? '' : '；未创建新版本'}）`;
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
          clarificationRequested = true;
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
    let unsubscribe: (() => void) | undefined;
    try {
      throwIfCancelled();
      const files = await workspace.listFiles();
      let selectedElementContext: string | undefined;
      if (turn.request.sourceId) {
        try {
          selectedElementContext = await workspace.inspectElement(turn.request.sourceId, { detail: 'compact' });
          selectedElementContextAvailable = true;
        } catch {
          // A stale selection should not prevent semantic lookup inside the workspace.
        }
      }
      throwIfCancelled();
      activeAgent = this.factory({
        providerId: 'openai-compatible',
        modelId: this.options.modelName,
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
        systemPrompt: `${modeRules}\n单轮最多 ${this.maxIterations} 次模型决策；从第 ${Math.max(1, this.maxIterations - FINALIZATION_WINDOW + 1)} 轮起必须停止扩展读取，只能完成必要修改并 finish，或 clarify。`,
        tools,
        maxIterations: this.maxIterations,
        maxOutputTokens: this.maxOutputTokens
      });
      unsubscribe = activeAgent.subscribe?.(event => {
        const timestamp = new Date().toISOString();
        if (event.type === 'model-call-updated' && 'call' in event) {
          const call = modelCallProgressSchema.safeParse(event.call);
          if (call.success) safeEmit(observe, { type: 'coding-agent.model.updated', timestamp, call: call.data });
        }
        if (event.type === 'tool-started' && 'toolCall' in event) {
          const tool = event.toolCall as { toolName?: string } | undefined;
          if (tool?.toolName) safeEmit(observe, { type: 'coding-agent.tool.started', timestamp,
            action: tool.toolName, modelCall: Number(event.iteration) || 1 });
        }
      });
      if (signal?.aborted) abortActiveAgent();
      const result = await activeAgent.run(JSON.stringify({
        instruction: turn.request.instruction,
        selectedSourceId: turn.request.sourceId,
        replyToClarificationId: turn.request.replyToClarificationId,
        clarificationOptionId: turn.request.clarificationOptionId,
        conversation: turn.conversation.slice(-8),
        files,
        workspaceMode: files.some(file => file.path === 'author.css' || file.path === 'author-style-links.json')
          ? 'author-rules'
          : 'frozen-styles',
        selectedElementContext
      }));
      checkpoint = {
        ...checkpoint,
        modelCalls: Math.max(checkpoint.modelCalls, result.iterations),
        ...(result.diagnostics ? { runtime: result.diagnostics } : {})
      };
      throwIfCancelled();
      if (completion?.kind === 'completed') {
        response = {
          kind: 'completed',
          summary: `${completion.summary}（${completion.validation}；已完成源码规则校验，交互行为与视觉效果需在副本页面确认）`,
          revision: completion.revision,
          unchanged: completion.unchanged,
          modelCalls: checkpoint.modelCalls,
          toolCalls: checkpoint.toolCalls
        };
      } else if (completion?.kind === 'draft') {
        response = {
          kind: 'draft',
          summary: `${completion.summary}（${completion.validation}；等待真实渲染验证）`,
          candidate: completion.candidate,
          intent: completion.intent,
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
          result.error ?? new Error(`Agent 未成功提交或澄清（status=${result.status}；最后操作=${checkpoint.lastAction ?? '无'}；最后工具错误=${steps.filter(step => step.error).at(-1)?.error ?? '无'}）`)
        );
      }
    } catch (error) {
      try {
        await rollback();
      } catch {
        // Preserve the primary agent error.
      }
      response = error instanceof CodingAgentCancelledError || signal?.aborted
        ? { kind: 'cancelled', message: '已停止本轮修改，未提交任何变更。' }
        : failedResponse(error);
    }

    unsubscribe?.();
    signal?.removeEventListener('abort', abortActiveAgent);
    activeAgent = undefined;

    const timestamp = new Date().toISOString();
    checkpoint = {
      ...checkpoint,
      lifecycle: {
        submissionMode: workspace.submissionMode ?? 'direct', intentDeclared, spatialScopeValidated,
        completionAttempts: steps.filter(step => step.action === 'finish').length,
        rollback: rollbackStatus,
        selectedElementContextProvided: selectedElementContextAvailable,
        preMutationReadCalls,
        ...(firstMutationAt ? {
          firstMutationAt,
          firstMutationModelCall,
          timeToFirstMutationMs: Date.parse(firstMutationAt) - Date.parse(startedAt)
        } : {})
      },
      status: response.kind === 'completed'
        || response.kind === 'draft'
        ? 'completed'
        : response.kind === 'clarification'
          ? 'clarification'
          : response.kind === 'cancelled'
            ? 'cancelled'
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
  const parsedMaxOutputTokens = Number(env.CLINE_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS);
  if (!Number.isInteger(parsedMaxOutputTokens) || parsedMaxOutputTokens < 1) {
    throw new Error('CLINE_MAX_OUTPUT_TOKENS 必须是大于 0 的整数');
  }
  return new ClineCodingAgentAdapter({
    baseUrl: env.MODEL_BASE_URL,
    apiKey: env.MODEL_API_KEY,
    modelName: env.MODEL_NAME,
    maxIterations: parsedMaxIterations,
    maxOutputTokens: parsedMaxOutputTokens
  });
}
