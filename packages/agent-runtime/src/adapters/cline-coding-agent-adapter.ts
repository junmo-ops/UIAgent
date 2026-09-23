import {
  Agent,
  createTool as createRuntimeTool,
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
} from '../core/coding-agent-port';
import { INTERACTION_INSTRUCTIONS } from '../source-editing/interaction-instructions';
import { toolCallStatistics } from '../core/tool-call-statistics';

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

function boundedInspection(result: string, budget: number, seenLayout: Set<string>): string {
  budget = Math.max(600, budget - 300); // Reserve headings and omission notices.
  const clip = (value: string, limit: number) => value.length <= limit ? value
    : `${value.slice(0, Math.max(0, limit - 40))}\n[本项已省略部分内容；按需定向读取]`;
  const lines = result.split('\n');
  const layoutLine = lines.find(line => line.startsWith('布局上下文: '));
  const sourceStart = result.indexOf('domText: ');
  const styleStart = result.indexOf('组件与样式上下文:');
  const source = [
    clip(lines.find(line => line.startsWith('domText: ')) ?? '', Math.floor(budget * 0.08)),
    clip(lines.find(line => line.startsWith('compactHtml: ')) ?? '', Math.floor(budget * 0.22))
  ].filter(Boolean).join('\n');
  const styles = styleStart >= 0 ? result.slice(styleStart, sourceStart >= 0 ? sourceStart : undefined) : '';
  const layoutBudget = Math.floor(budget * 0.4);
  const layout: Record<string, unknown> = {};
  let omitted = 0;
  if (layoutLine) {
    const facts = JSON.parse(layoutLine.slice('布局上下文: '.length)) as Record<string, unknown>;
    for (const [kind, value] of Object.entries(facts)) {
      const nodes = Array.isArray(value) ? value : [value];
      const accepted: unknown[] = [];
      for (const originalNode of nodes) {
        if (!originalNode || typeof originalNode !== 'object') continue;
        const fact = originalNode as Record<string, unknown>;
        let node = Object.fromEntries(Object.entries(fact).filter(([key]) =>
          !['cascadeNote', 'layoutEvidence'].includes(key)));
        if (kind === 'target' && JSON.stringify(node).length > layoutBudget) {
          node = { sourceId: fact.sourceId, tag: fact.tag, capturedRect: fact.capturedRect };
          for (const [key, value] of Object.entries((fact.computedLayout ?? {}) as Record<string, unknown>)) {
            const computedLayout = { ...(node.computedLayout as Record<string, unknown> ?? {}), [key]: value };
            if (JSON.stringify({ ...node, computedLayout }).length <= layoutBudget - 20) node.computedLayout = computedLayout;
            else omitted++;
          }
          omitted++; // Other target fields are intentionally omitted at this budget.
        }
        const key = JSON.stringify(node);
        if (kind !== 'target' && seenLayout.has(key)) { omitted++; continue; }
        const candidate = { ...layout, [kind]: Array.isArray(value) ? [...accepted, node] : node };
        if (JSON.stringify(candidate).length > layoutBudget) { omitted++; continue; }
        accepted.push(node);
        layout[kind] = Array.isArray(value) ? [...accepted] : node;
        seenLayout.add(key);
      }
    }
  }
  return [
    clip(lines[0] ?? '', 180),
    '源码摘要（非精确原文；精确替换请按字符范围 read_file）：',
    clip(source, Math.floor(budget * 0.3)),
    clip(styles, Math.floor(budget * 0.2)),
    `布局上下文（捕获值不是修改后的渲染测量）: ${JSON.stringify(layout)}`,
    ...(omitted ? [`[省略 ${omitted} 项重复或超预算布局；需要时单独检查目标]`] : [])
  ].filter(Boolean).join('\n');
}

// Keep legacy positions in the internal protocol for existing callers, but
// expose only the explicit-target vocabulary to the model, including batches.
function modelOperationSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(modelOperationSchema);
  if (!value || typeof value !== 'object') return value;
  const schema = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, modelOperationSchema(child)]));
  if (Array.isArray(schema.enum)) schema.enum = schema.enum.filter(item => item !== 'parentStart' && item !== 'parentEnd');
  const properties = schema.properties as Record<string, { const?: string }> | undefined;
  if (properties?.kind?.const === 'move' || properties?.kind?.const === 'clone') {
    schema.required = [...new Set([...(schema.required as string[] ?? []), 'targetSourceId'])];
  }
  return schema;
}

const INTERACTION_BEHAVIOR_FIELDS = [
  'initialState', 'trigger', 'result', 'layoutBehavior', 'completionBehavior', 'nodeIdentity'
] as const;

function interactionPlanSchema(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const fields = Object.fromEntries(Object.entries(properties).map(([name, schema]) => [
    name, schema.type === 'string' ? { ...schema, minLength: 1 } : schema
  ]));
  return {
    anyOf: [
      objectSchema({ ...fields, mode: { ...fields.mode, enum: ['none', 'preserve-existing'] } }, ['mode']),
      objectSchema({ ...fields, mode: { ...fields.mode, enum: ['local-demo'] } }, ['mode', ...INTERACTION_BEHAVIOR_FIELDS])
    ]
  };
}

function spatialScopeSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { ...objectSchema(properties, required), anyOf: [
    objectSchema({ ...properties, scope: { type: 'string', enum: ['global'] } }, required),
    objectSchema({ ...properties, scope: { type: 'string', enum: ['selected-context', 'explicit-container'] },
      containerSourceId: { type: 'string', minLength: 1 } }, [...required, 'containerSourceId'])
  ] };
}

function createTool<TInput, TOutput>(config: AgentTool<TInput, TOutput>): AgentTool<TInput, TOutput> {
  const validateRequiredFields = (
    schema: Record<string, unknown>,
    value: unknown,
    path: string,
    issues: string[]
  ): void => {
    if (Array.isArray(schema.anyOf)) {
      const branches = schema.anyOf as Record<string, unknown>[];
      const branchIssues = branches.map(branch => {
        const errors: string[] = [];
        validateRequiredFields(branch, value, path, errors);
        return errors;
      });
      if (!branchIssues.some(errors => errors.length === 0)) {
        issues.push(`${path}: ${branchIssues.map(errors => errors.join('、')).join('；或 ')}`);
        return;
      }
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      issues.push(`${path} 应为 ${schema.enum.join(' / ')}`);
    }
    if ('const' in schema && value !== schema.const) issues.push(`${path} 应为 ${String(schema.const)}`);
    if ((schema.type === 'number' || schema.type === 'integer') && (typeof value !== 'number'
      || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))
      || (typeof schema.minimum === 'number' && value < schema.minimum)
      || (typeof schema.maximum === 'number' && value > schema.maximum))) {
      issues.push(`${path} 应为范围内的${schema.type === 'integer' ? '整数' : '数字'}`);
    }
    if (schema.type === 'string' && (typeof value !== 'string'
      || (typeof schema.minLength === 'number' && value.length < schema.minLength))) {
      issues.push(`${path} 应为满足长度要求的字符串`);
    }
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        issues.push(`${path || 'input'} 应为对象`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const key of (schema.required as string[] | undefined) ?? []) {
        if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined || record[key] === null) {
          issues.push(path ? `${path}.${key}` : key);
        }
      }
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      for (const [key, propertySchema] of Object.entries(properties ?? {})) {
        if (record[key] !== undefined && record[key] !== null) {
          validateRequiredFields(propertySchema, record[key], path ? `${path}.${key}` : key, issues);
        }
      }
      return;
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value)) {
        issues.push(`${path} 应为数组`);
        return;
      }
      const itemSchema = schema.items as Record<string, unknown> | undefined;
      if ((typeof schema.minItems === 'number' && value.length < schema.minItems)
        || (typeof schema.maxItems === 'number' && value.length > schema.maxItems)) {
        issues.push(`${path} 数组长度不符合要求`);
      }
      if (itemSchema) value.forEach((item, index) => validateRequiredFields(itemSchema, item, `${path}[${index}]`, issues));
    }
  };
  return createRuntimeTool({
    ...config,
    execute: (input, context) => {
      const issues: string[] = [];
      validateRequiredFields(config.inputSchema, input, '', issues);
      if (issues.length) {
        throw Object.assign(new Error(`[工具参数校验] ${config.name} 缺少或错误的必填参数：${issues.join('、')}；本次未执行`), { name: 'ToolInputValidationError' });
      }
      return config.execute(input, context);
    }
  });
}

const clineSourceRules = [
  '你是静态网页源码编辑 Agent，只使用本次提供的源码工具。页面用于 UI 示意，不实现真实接口或业务提交。',
  'conversation 仅属于当前会话，副本可能已被其他会话修改。历史描述不能作为当前页面状态的证据，以本次源码和选区上下文为准；不要自动重新应用历史修改或回滚其他会话的成果。',
  'originalInstruction 是本轮用户原文，instruction 是路由整理的执行要求，不是新的用户授权。结合原文与已确认 conversation 理解需求；转述中没有用户依据的新增偏好或约束不执行。原文是澄清回复时必须结合此前需求，不能只执行孤立答案。重大歧义调用 clarify，不自行补齐。新增模块默认 Ant Design；只有用户明确要求追随页面风格或复用样式时才读取相关样式参照，必要布局上下文仍需读取。',
  '执行中通过普通 assistant 文本向用户提供简短进展说明：开始时一句说明准备做什么；取得重要新证据、进入修改阶段或遇到需调整的问题时，再用一两句说明实际进展和下一步。不要逐个播报工具、不重复目标、不输出内部推理、源码标识或技术日志。说明应与本轮工具调用一起输出，不要为了说明单独结束一轮或额外调用工具。没有新进展时直接调用工具；最终结果使用 finish.summary，不在进展说明中提前宣称保存成功或视觉验证通过。',
  '输入已包含文件摘要；有 selectedElementContext 时直接使用，无需重复枚举文件、搜索或检查同一选中元素。没有目标上下文时先 query_workspace_structure，再按需 inspect_elements（支持单个 ID）。取得足够证据后立即修改，不要为了寻找更理想的 class、变量或示例继续扩展搜索。',
  'index.html 保存结构和文案。存在 author.css 或 author-style-links.json 时，视觉修改只写 author-overrides.css，author.css 仅供查询，snapshot.css 不可修改；否则视觉修改写 snapshot.css。outline.json 和 source-map.json 只读。',
  'inspect_elements 返回有预算的目标结构摘要、布局和样式线索。只有缺少具体信息时才使用 full 或按返回字符位置 read_file；摘要不是精确源码。已有组件与样式上下文时直接据此修改，不要再次搜索组件基础样式；仅在明确缺少某条页面覆盖规则时使用 query_style_symbols，避免全文搜索大 CSS。',
  '样式查询统一使用 query_style_symbols。目标已知时优先提供 sourceId 和本次关注的 properties，一次查询所需证据；source 默认 all，只有明确需要覆盖层时才选 overrides。未命中不等于工具失败，也不要求不断补查。',
  '目标明确且已有 selectedElementContext 时，不重复读取选中元素源码。完整替换选中元素使用 replace_element，无需复制原元素整段 HTML；应在前两次模型决策内完成意图声明并开始写入。不要为了比较未被用户要求的视觉方案检索相邻示例。',
  '修改前只需确认目标、最近相关容器和必要的相邻元素。复制原样保留原结构，小改保留现有实现；新增、重做、改变控件类型或组合交互统一使用 Ant Design 局部模块。只读取必要布局证据，明确风格要求时只读取相关参照。修改行内样式时注意级联优先级，背景也可能由子元素或伪元素绘制。',
  '位置描述以用户明确容器为准，否则以 selectedSourceId 或最近语义祖先为锚点。相邻组件只扩展到最近公共父容器；用户未明确要求全局视口定位时不得新增 position:fixed。新增元素后调用 validate_spatial_scope。',
  '若多个方案会显著改变最终视觉结果，修改前调用 clarify；问题只询问源码无法确定的信息。已有澄清回复时结合 conversation 继续原需求。保留 button、input 等语义表示最终渲染标签和可访问行为保持一致，不等于必须保留原 sourceId 或原 DOM 节点；只有用户明确要求保留节点身份时才按原节点修改。',
  '首次写入前调用一次 declare_intent，简洁列出目标、相关 sourceId、供用户检查的效果约束和布局范围。涉及交互时必须明确初始状态、触发动作、出现内容、是否占据布局、结束状态和节点身份策略。declare_intent 是方案决策边界；成功后按已声明方案执行，只有工具返回新的冲突证据时才调整，不重新比较组件或交互方案。新增 sourceId 会由系统自动加入验证范围。',
  '已明确实际文本承载元素时优先 set_element_text；含图标或其他子结构的父控件不能直接清空，应定位文字子元素，不确定时再 inspect。属性、插入、完整元素替换、移动、删除和批量操作使用对应结构化工具；完整替换已有元素使用 replace_element，元素内部精确替换才使用 replace_in_element，search 必须来自已读取的原始源码，禁止根据 compactHtml、domText 或结构摘要拼接 HTML，文件级精确替换必须基于已读取原文，追加 CSS 使用 apply_patch。相关修改尽量在同一轮并行调用或用批量工具完成。',
  '不得添加 script、事件属性、远程资源、接口请求、表单 action 或 javascript: URL。',
  INTERACTION_INSTRUCTIONS,
  '修改完成后直接调用 finish；finish 会执行工作区校验。新增元素仍须先完成空间归属校验。源码和捕获布局不能证明真实渲染结果，不得声称已经通过浏览器验证。无需修改时提供源码证据并使用 already_satisfied。',
  'finish.summary 是给产品用户看的结果说明，不是技术执行日志。用 1～3 句自然语言说明改了什么；仅在有新增交互时补充如何使用，仅在影响用户预期时说明实际限制（例如仅为演示、未连接真实检索）。简单文案修改一句即可。不罗列 sourceId、文件名、class、React/组件库、工具名或校验过程，不复述完整需求，不追加通用验证免责声明。不得把源码校验表述成已验证视觉效果，不承诺无裁切、绝不影响其他区域。确有未完成项或已知风险必须明确说明，不能为简短而隐瞒。技术细节保留在工具调用日志。',
  '没有调用 finish 或 clarify，本轮不算完成。保持推理和工具说明简洁，不做无关重构。',
  '完成回复优先压缩为两句：一句概括结果，另一句仅补充必要操作方法或真实限制。不要逐项复述标题、占位文案、提示文案、尺寸和颜色；除非用户要求逐项核对。不得为了简短隐瞒未完成项，也不通过截断字符串压缩结果。'
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
  inspect_elements: 3,
  query_style_symbols: 3,
  read_file: 3
};
const BUDGETED_READ_ACTIONS = new Set([
  'query_workspace_structure', 'search_text', 'read_file', 'inspect_elements',
  'query_style_symbols'
]);
const MUTATING_ACTIONS = new Set([
  'apply_patch', 'replace_in_element', 'replace_element', 'set_element_text', 'set_element_attributes',
  'insert_element', 'wrap_element', 'unwrap_element', 'remove_element', 'reorder_children',
  'apply_dom_operations', 'move_element', 'clone_element'
]);

function repeatedFailureGuidance(action: string): string {
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

  async run(
    turn: CodingAgentTurn,
    workspace: CodingWorkspaceTools,
    observe?: CodingAgentObserver,
    signal?: AbortSignal
  ): Promise<CodingAgentRunResult> {
    const finishDescription = 'finish 校验并直接提交正式 Revision；实际页面效果由用户检查，不得声称自动渲染验证通过。';
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
    let originalSelectedPath: string[] = [];
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
      if (rolledBack || completion?.kind === 'completed') return;
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
      outcome?: 'blocked',
      blockReason?: CodingAgentStep['blockReason']
    ) => {
      const timestamp = new Date().toISOString();
      const step: CodingAgentStep = {
        timestamp,
        toolCallId: context.toolCallId,
        outcome: error ? 'failed' : outcome ?? 'succeeded',
        ...(blockReason ? { blockReason } : {}),
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
        toolCalls: checkpoint.toolCalls + 1,
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

    const readBudgetGuidance = () => {
      if (!selectedElementContextAvailable || firstMutationAt) return '';
      const remaining = Math.max(0, MAX_PRE_MUTATION_READS_WITH_SELECTED_CONTEXT - preMutationReadCalls);
      return `[修改前读取额度] 已提供选区上下文；补充读取已用 ${preMutationReadCalls}/${MAX_PRE_MUTATION_READS_WITH_SELECTED_CONTEXT} 次，剩余 ${remaining} 次（按工具调用计数，同轮多次调用分别计数）。${remaining === 0
        ? '下一步不要再请求读取；证据足够则声明意图并修改，缺少会显著影响结果的信息则 clarify，不猜测布局。'
        : '仅为明确缺失的证据读取，不必用满额度；证据足够则声明意图并修改。'} 各读取工具另有上限：${JSON.stringify(MAX_READ_CALLS_PER_ACTION)}。`;
    };

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
      if (BUDGETED_READ_ACTIONS.has(action) && action !== 'inspect_elements'
        && context.iteration >= finalizationStartsAt) {
        const message = `[运行预算] 当前第 ${context.iteration}/${this.maxIterations} 轮，已进入最后 ${FINALIZATION_WINDOW} 轮，停止继续读取。若修改已完成，请立即调用 finish；若关键信息仍不足，请调用 clarify。`;
        record(action, input, context, message, undefined, 'blocked', 'finalization_budget');
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
        record(action, input, context, message, undefined, 'blocked', 'read_budget');
        return message;
      }
      if (readKey && completedReadResults.has(readKey)) {
        const message = '[重复读取已拦截] 当前源码版本的相同查询已经返回，请使用已有证据；修改源码后可重新检查。';
        record(action, input, context, message, undefined, 'blocked', 'duplicate_read');
        return message;
      }
      if (actionLimit) {
        const actionCount = (readActionCounts.get(budgetKey) ?? 0) + 1;
        readActionCounts.set(budgetKey, actionCount);
        if (actionCount > actionLimit) {
          const message = `[读取预算] ${action} 已调用 ${actionCount} 次，超过本轮上限 ${actionLimit} 次。请停止继续检索，使用已有上下文完成修改和校验；若信息不足则调用 clarify。`;
          record(action, input, context, message, undefined, 'blocked', 'read_budget');
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
        const finalizationResult = remainingAfterThisCall <= 5
          ? `[运行预算] 当前第 ${context.iteration}/${this.maxIterations} 轮，本次后最多剩余 ${remainingAfterThisCall} 轮。请停止扩展范围，完成必要修改并预留 finish。\n\n${result}`
          : result;
        const guidance = BUDGETED_READ_ACTIONS.has(action) ? readBudgetGuidance() : '';
        const guidedResult = guidance ? `${guidance}\n\n${finalizationResult}` : finalizationResult;
        record(action, input, context, guidedResult);
        return guidedResult;
      } catch (error) {
        const baseMessage = error instanceof Error ? error.message : String(error);
        const failureKey = `${action}:${baseMessage}`;
        const repeated = (repeatedFailures.get(failureKey) ?? 0) + 1;
        repeatedFailures.set(failureKey, repeated);
        const message = repeated >= 2
          ? `${baseMessage}。同一错误已重复 ${repeated} 次，${repeatedFailureGuidance(action)}。`
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
        interactionPlan: {
          mode: 'none' | 'preserve-existing' | 'local-demo';
          initialState?: string;
          trigger?: string;
          result?: string;
          layoutBehavior?: 'unchanged' | 'overlay' | 'in-flow';
          completionBehavior?: string;
          nodeIdentity?: 'preserve-source-node' | 'preserve-semantic-role' | 'replace-node';
        };
        relevantSourceIds?: string[];
        verificationSourceIds?: string[];
        visualConstraints?: string[];
        layoutScope?: 'selected-context' | 'explicit-container' | 'global';
      }, string>({
        name: 'declare_intent',
        description: '首次写入前简洁声明目标、范围和保持约束。none / preserve-existing 只需 interactionPlan.mode，无需虚构触发或结束行为；local-demo 必须完整描述新增或改变的交互。有关键歧义时 clarify。声明成功后直接执行。',
        inputSchema: objectSchema({
          summary: stringProperty('展示给用户的简短行动说明：准备改什么、必要时说明保留什么，最多两句话。不要包含内部推理、sourceId、文件名或未经验证的完成结论。'),
          interactionPlan: interactionPlanSchema({
            mode: {
              type: 'string',
              enum: ['none', 'preserve-existing', 'local-demo'],
              description: '无交互改动、保留既有交互，或使用 React 本地状态实现演示交互。真实业务行为不在副本能力内，应 clarify。'
            },
            initialState: stringProperty('操作前用户看到的内容。'),
            trigger: stringProperty('触发交互的具体用户动作。'),
            result: stringProperty('触发后具体出现或变化的内容。'),
            layoutBehavior: {
              type: 'string',
              enum: ['unchanged', 'overlay', 'in-flow'],
              description: '交互结果不影响布局、以浮层覆盖展示，或进入普通布局占据空间。'
            },
            completionBehavior: stringProperty('选择、确认或再次点击后的状态。'),
            nodeIdentity: {
              type: 'string',
              enum: ['preserve-source-node', 'preserve-semantic-role', 'replace-node'],
              description: '保留原 sourceId 节点、只保留最终标签和可访问语义，或允许替换节点。'
            }
          }),
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
            items: stringProperty('预期的简洁视觉或结构约束，供用户检查；声明约束不代表已经验证。')
          },
          layoutScope: { type: 'string', enum: ['selected-context', 'explicit-container', 'global'] }
        }, ['summary', 'interactionPlan']),
        execute: (input, context) => execute(
          'declare_intent',
          input,
          context,
          async () => {
            const interactionPlan = input.interactionPlan;
            const sourceIds = [...new Set([
              ...(turn.request.sourceId ? [turn.request.sourceId] : []),
              ...(input.relevantSourceIds ?? []),
              ...(input.verificationSourceIds ?? [])
            ])];
            const interactionConstraint = interactionPlan.mode === 'none'
              ? undefined
              : interactionPlan.mode === 'preserve-existing'
                ? '保留既有交互；本轮只执行声明的修改目标和约束'
                : `交互方案：初始=${interactionPlan.initialState}；触发=${interactionPlan.trigger}；结果=${interactionPlan.result}；布局=${interactionPlan.layoutBehavior}；结束=${interactionPlan.completionBehavior}；节点=${interactionPlan.nodeIdentity}`;
            const constraints = [...new Set([
              ...(input.visualConstraints?.length ? input.visualConstraints : [input.summary]),
              ...(interactionConstraint ? [interactionConstraint] : [])
            ])];
            if (!sourceIds.length) {
              throw new Error('declare_intent 必须列出至少一个实际相关的 sourceId；请先查询并检查目标结构，无法定位时调用 clarify');
            }
            intentDeclared = true;
            declaredIntent = {
              intentId: randomUUID(),
              version: 0,
              instruction: turn.request.instruction,
              sourceIds,
              constraints,
              layoutScope: input.layoutScope ?? 'selected-context',
              createdAt: new Date().toISOString()
            };
            return `意图已声明并锁定实现方案：${input.summary}${interactionConstraint ? `；${interactionConstraint}` : '；本轮无交互改动'}。除非工具返回新的冲突证据，请直接执行并完成校验。`;
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
      createTool<{ sourceIds: string[]; detail?: 'compact' | 'full' }, string>({
        name: 'inspect_elements',
        description: '检查一个或多个元素。默认 compact，full 返回更多布局与源码摘要；摘要不能用于精确替换，原文使用 read_file。各目标都有独立预算，不因前一个元素过长而丢失后续目标。',
        inputSchema: objectSchema({
          detail: { type: 'string', enum: ['compact', 'full'] },
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
            const ids = [...new Set(input.sourceIds)];
            const budget = Math.min(ids.length === 1 ? MAX_BATCH_INSPECTION_CHARS : MAX_BATCH_ELEMENT_CHARS,
              Math.floor(MAX_BATCH_INSPECTION_CHARS / ids.length));
            const seenLayout = new Set<string>();
            const results = await Promise.all(ids.map(sourceId =>
              workspace.inspectElement(sourceId, { detail: input.detail ?? 'compact' })));
            const sections = results.map(result => boundedInspection(result, budget, seenLayout));
            return sections.join('\n\n---\n\n');
          }
        )
      }),
      createTool<{ symbols?: string[]; sourceId?: string; source?: 'all' | 'original' | 'overrides'; properties?: string[] }, string>({
        name: 'query_style_symbols',
        description: '统一查询样式。优先 sourceId 配合 properties 查询目标结构适用的属性规则；也可按 symbols 查询 class/变量。source 默认 all，original 查原站，overrides 查可编辑层。未命中是正常结果，不必重复读取。返回候选规则，不是最终渲染样式。',
        inputSchema: { ...objectSchema({
          symbols: {
            type: 'array', minItems: 1, maxItems: 12,
            items: stringProperty('class 名（可带点）或以 -- 开头的 CSS 自定义属性。')
          },
          sourceId: stringProperty('目标元素 sourceId；与 symbols 至少提供一项。'),
          source: { type: 'string', enum: ['all', 'original', 'overrides'] },
          properties: { type: 'array', minItems: 1, maxItems: 12, items: stringProperty('关注的 CSS 属性，例如 height、padding、box-sizing；只返回相关规则。') }
        }, []), anyOf: [
          { type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'string', minLength: 1 } } },
          { type: 'object', required: ['symbols'], properties: { symbols: { type: 'array', minItems: 1 } } }
        ] },
        execute: (input, context) => execute(
          'query_style_symbols', input, context, () => {
            if (!input.sourceId && !input.symbols?.length) throw new Error('请提供 sourceId 或非空 symbols');
            return workspace.queryStyleSymbols(input.symbols ?? [], input);
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
        description: '原子应用一组受控源码编辑。支持精确替换，以及在文件开头、末尾或唯一锚点前后插入；适合编写 module.jsx 或追加 CSS。',
        inputSchema: objectSchema({
          path: stringProperty('只允许 index.html、module.jsx，以及当前模式的样式文件：原始规则模式为 author-overrides.css，冻结模式为 snapshot.css。module.js 是平台编译产物。'),
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { anyOf: [
              objectSchema({ kind: { type: 'string', enum: ['replace'] },
                search: { type: 'string', minLength: 1 }, replace: { type: 'string' } }, ['kind', 'search', 'replace']),
              objectSchema({ kind: { type: 'string', enum: ['insert'] },
                position: { type: 'string', enum: ['start', 'end'] }, text: { type: 'string', minLength: 1 } }, ['kind', 'position', 'text']),
              objectSchema({ kind: { type: 'string', enum: ['insert'] },
                position: { type: 'string', enum: ['before', 'after'] }, text: { type: 'string', minLength: 1 },
                anchor: { type: 'string', minLength: 1 } }, ['kind', 'position', 'text', 'anchor'])
            ] }
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
              trackCreatedSourceIdsFromResult(result);
            } else if (input.path !== 'module.jsx') {
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
        description: '仅用于基于已读取原始源码的元素内部精确替换。纯文本、属性修改优先使用 set_element_text / set_element_attributes；禁止从 compactHtml 或结构摘要拼接 search。',
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
            trackCreatedSourceIdsFromResult(result);
            return result;
          }
        )
      }),
      createTool<{ sourceId: string; html: string }, string>({
        name: 'replace_element',
        description: '按 sourceId 原子替换一个完整元素，保持原位置，并为替换后的单个顶层元素及其后代生成全新 sourceId。适合把选中控件替换为 ui-agent-module；已有 selectedElementContext 时无需再读取原元素整段 HTML。',
        inputSchema: objectSchema({
          sourceId: stringProperty('要完整替换的现有元素 sourceId。'),
          html: stringProperty('替换后的一个安全 HTML 顶层元素；新增 sourceId 由系统生成。')
        }, ['sourceId', 'html']),
        execute: (input, context) => execute(
          'replace_element',
          input,
          context,
          async () => {
            requireIntentDeclared();
            if (!workspace.replaceElement) throw new Error('当前源码工作区不支持完整元素替换');
            const result = await workspace.replaceElement(input.sourceId, input.html);
            trackCreatedSourceIdsFromResult(result);
            return result;
          }
        )
      }),
      createTool<{ sourceId: string; text: string }, string>({
        name: 'set_element_text',
        description: '已定位纯文本承载元素时优先使用，无需构造原文匹配。文本会安全转义，原有子元素会被移除；应选择实际文字子元素，不能误删父控件中的图标或其他结构。无法确定目标结构时先 inspect。',
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
        position: 'insideStart' | 'insideEnd' | 'before' | 'after';
        html: string;
        styleReferenceSourceId?: string;
      }, string>({
        name: 'insert_element',
        description: '在目标元素内部开头/末尾或目标前后插入静态 HTML；系统为所有新元素生成 sourceId。可选提供已检查的同类元素作为冻结计算样式参照。',
        inputSchema: objectSchema({
          targetSourceId: stringProperty('定位目标 sourceId。'),
          position: { type: 'string', enum: ['insideStart', 'insideEnd', 'before', 'after'], description: 'insideStart/insideEnd 表示 targetSourceId 内部，before/after 表示目标外部前后。' },
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
            items: modelOperationSchema(z.toJSONSchema(domOperationSchema))
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
        position: 'insideStart' | 'insideEnd' | 'before' | 'after';
        targetSourceId: string;
      }, string>({
        name: 'move_element',
        description: '按 sourceId 原样移动元素，所有位置均相对于必填的 targetSourceId。insideStart/insideEnd 放入目标容器内部；before/after 放在目标外部前后。',
        inputSchema: objectSchema({
          sourceId: stringProperty('要移动的现有元素 sourceId。'),
          position: { type: 'string', enum: ['insideStart', 'insideEnd', 'before', 'after'] },
          targetSourceId: stringProperty('目标元素或目标容器 sourceId。')
        }, ['sourceId', 'position', 'targetSourceId']),
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
        position: 'replace' | 'insideStart' | 'insideEnd' | 'before' | 'after';
        targetSourceId: string;
        replacements?: Array<{ search: string; replace: string }>;
      }, string>({
        name: 'clone_element',
        description: '克隆元素并生成新 sourceId。所有位置相对于必填 targetSourceId：insideStart/insideEnd 为目标内部，before/after 为目标外部前后，replace 替换目标。',
        inputSchema: objectSchema({
          templateSourceId: stringProperty('要复用的现有组件 sourceId。'),
          position: { type: 'string', enum: ['replace', 'insideStart', 'insideEnd', 'before', 'after'] },
          targetSourceId: stringProperty('插入或替换的目标 sourceId。'),
          replacements: {
            type: 'array',
            maxItems: 50,
            items: objectSchema({
              search: stringProperty('模板内唯一原文。'),
              replace: stringProperty('替换内容。')
            }, ['search', 'replace'])
          }
        }, ['templateSourceId', 'position', 'targetSourceId']),
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
        inputSchema: spatialScopeSchema({
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
                let selectedPath: string[];
                try {
                  selectedPath = ancestrySourceIds(await workspace.inspectElement(selectedSourceId));
                } catch (error) {
                  if (!(error instanceof Error) || !error.message.includes(`源码中不存在元素 ${selectedSourceId}`)
                    || !originalSelectedPath.length) throw error;
                  selectedPath = originalSelectedPath;
                }
                // The selected node may have been replaced, but the claimed
                // container must still exist and contain the new nodes.
                await workspace.inspectElement(input.containerSourceId);
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
          summary: stringProperty('通常两句：概括修改结果，必要时补充操作方法或真实限制。不逐项复述标题、占位文字和样式细节，不写技术日志；如有未完成项必须说明，不声称未经验证的视觉效果。'),
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
            safeEmit(observe, { type: 'coding-agent.persistence.updated', timestamp: new Date().toISOString(),
              state: commit.changed ? 'saved' : 'unchanged', revision: commit.revision });
            if (!commit.changed && input.outcome !== 'already_satisfied') {
              throw new Error('当前副本没有新增源码修改；仅在确认目标已满足时，才能以 outcome=already_satisfied 结束本轮');
            }
            const summary = commit.changed
              ? input.summary
              : `当前副本已满足该需求，无需重复修改。${input.summary}`;
            completion = { kind: 'completed', summary, validation, revision: commit.revision, unchanged: !commit.changed };
            const result = `${summary}（${validation}；revision=${commit.revision}${commit.changed ? '' : '；未创建新版本'}）`;
            record('finish', input, context, result);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            record('finish', input, context, undefined, message);
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
          record('clarify', input, context, input.question);
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
          originalSelectedPath = ancestrySourceIds(selectedElementContext);
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
      let commentaryCall = 0;
      let commentaryText = '';
      let publishedCommentary = '';
      const publishCommentary = () => {
        const text = commentaryText.trim().slice(0, 600);
        if (!text || text === publishedCommentary || commentaryCall < 1) return;
        publishedCommentary = text;
        safeEmit(observe, { type: 'coding-agent.commentary', timestamp: new Date().toISOString(),
          modelCall: commentaryCall, text });
      };
      unsubscribe = activeAgent.subscribe?.(event => {
        const timestamp = new Date().toISOString();
        // Only explicit assistant text is public commentary. Never consume
        // reasoning deltas or accumulatedText (which spans multiple rounds).
        if (event.type === 'assistant-text-delta' && typeof event.text === 'string') {
          const iteration = Number(event.iteration);
          if (!Number.isInteger(iteration) || iteration < 1) return;
          if (commentaryCall !== iteration) {
            commentaryCall = iteration;
            commentaryText = '';
            publishedCommentary = '';
          }
          commentaryText = (commentaryText + event.text).slice(0, 600);
          publishCommentary();
        }
        if (event.type === 'model-call-updated' && 'call' in event) {
          const call = modelCallProgressSchema.safeParse(event.call);
          if (call.success && call.data.status === 'completed') publishCommentary();
          if (call.success) safeEmit(observe, { type: 'coding-agent.model.updated', timestamp, call: call.data });
        }
        if (event.type === 'tool-started' && 'toolCall' in event) {
          publishCommentary();
          const tool = event.toolCall as { toolName?: string; toolCallId?: string } | undefined;
          if (tool?.toolName) safeEmit(observe, { type: 'coding-agent.tool.started', timestamp,
            action: tool.toolName, toolCallId: typeof tool.toolCallId === 'string' ? tool.toolCallId : undefined,
            modelCall: Number(event.iteration) || 1 });
        }
      });
      if (signal?.aborted) abortActiveAgent();
      const result = await activeAgent.run(JSON.stringify({
        instruction: turn.request.instruction,
        originalInstruction: turn.request.originalInstruction ?? turn.request.instruction,
        readBudget: readBudgetGuidance(),
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
        toolCalls: toolCallStatistics(result.diagnostics, steps).attempted,
        ...(result.diagnostics ? { runtime: result.diagnostics } : {})
      };
      throwIfCancelled();
      if (completion?.kind === 'completed') {
        response = {
          kind: 'completed',
          // Validation details remain in the recorded finish tool result.
          summary: completion.summary,
          revision: completion.revision,
          unchanged: completion.unchanged,
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
        submissionMode: 'direct', intentDeclared, spatialScopeValidated,
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

export function clineCodingAgentFromConfig(options: ClineCodingAgentOptions): ClineCodingAgentAdapter {
  if (!options.baseUrl || !options.apiKey || !options.modelName) throw new Error('模型配置和密钥不能为空');
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new Error('maxIterations 必须是正整数');
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('maxOutputTokens 必须是正整数');
  return new ClineCodingAgentAdapter({ ...options, maxIterations, maxOutputTokens });
}
