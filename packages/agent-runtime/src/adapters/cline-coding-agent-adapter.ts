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
import { validateRequirementReview, type RequirementReview } from '../source-editing/requirement-review';

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
  '已提供 selectedSourceId 时先 inspect_element 获取准确节点及上下文，无需把 sourceId 当语义关键词搜索。结构查询用于寻找未知节点。',
  'visualConstraints 必须完整覆盖原始请求及澄清中的文案、布局、初始状态、打开和关闭等交互要求。能力限制不能成为删除需求的理由。finish 前重新阅读原始请求和 conversation，填写 requirementReview，逐项关联实现证据；发现声明时漏掉的要求必须补做并重新声明完整意图，或调用 clarify 确认范围。implemented 只表示有源码实现证据，不代表真实视觉或交互测试通过，禁止把源码推断当浏览器验证。',
  '你是静态网页源码编辑 Agent。你只能使用本次会话显式提供的源码工具。',
  '页面只用于 UI 需求示意，不需要真实接口、脚本或业务提交。',
  '工作区包含 index.html、结构索引和样式文件。若 list_files 中存在 author.css 或 author-style-links.json，则当前使用原始规则模式：author.css 仅供读取和检索；author-style-links.json 仅记录可渲染、不可读取规则的外链，不能当作样式证据；视觉修改只能写入 author-overrides.css。snapshot.css 是 A 候选的冻结回退和布局事实，不得在该模式下修改。若两者都不存在，视觉修改写入 snapshot.css。',
  '先调用 list_files；若没有明确 sourceId，必须先调用 query_workspace_structure 定位语义结构。只有结构化查询不足时才搜索或读取 outline.json，不要直接读取整个大文件。',
  'index.html 保存页面结构。原始规则模式中，结构与文案修改 index.html、视觉修改 author-overrides.css；冻结模式中视觉修改 snapshot.css。outline.json 与 source-map.json 由系统维护，只能读取，不能修改。',
  'replace_text 的 search 必须来自刚刚读取的源码，且应足够唯一；不要猜测源码。',
  '需要在文件开头、末尾或明确锚点旁插入内容时使用 apply_patch，不要为了追加内容反复寻找唯一的文件尾字符串。',
  'inspect_element 会返回目标、祖先和兄弟节点的布局上下文（捕获时矩形与关键计算样式）、domText 和 styleClasses。必须先使用 compact；只有 compact 明确不足时才能对同一 sourceId 使用 full。domText 只证明文字存在于源码，不能证明渲染后可见。了解 class 或 CSS 变量时优先使用 query_style_symbols，不要反复全文搜索或切片读取大 CSS。',
  '需要检查多个元素时可使用 inspect_elements；该工具有整体输出预算，结果不足时只补查真正必要的单个元素。需要检查多个 class 或 CSS 变量时优先使用 query_style_symbols。',
  '修改视觉属性前检查 inspect 返回的 inlineStyle、目标及子元素的实际绘制规则和 CSS 变量引用。普通行内声明优先于任意普通样式表选择器；增加 class 数量或把规则放到文件末尾不能覆盖它。原始规则模式仍只写 author-overrides.css：需要覆盖普通行内声明时，可以对已确认目标的具体属性或自定义属性使用局部 !important；不要全局加 !important。行内本身为 !important 时不能宣称普通覆盖层已生效。背景可能由子元素或伪元素绘制，不能假设一定在容器自身。',
  '颜色、背景、边框等样式需求必须把可测量的样式目标列入 renderConstraintIndexes，并将实际绘制元素加入 verificationSourceIds。浏览器观察包含 backgroundColor、backgroundImage、color、borderColor、borderRadius、boxShadow；只有最终计算样式证据才能证明覆盖生效，捕获布局和 CSS 字符串不能证明。未采集的状态或伪元素不得宣称验证通过。',
  '先用一次结构化查询取得候选元素，再一次批量 inspect 取得目标、父级和同级上下文；不得为同一语义目标连续搜索不同关键词来猜测层级。相同参数的读取或空间校验不会产生新证据，禁止重复调用。',
  '新增可见控件前，必须批量检查目标容器和相邻同类控件的布局；优先 clone 相邻同类结构。冻结模式可使用 insert_element 的 styleReferenceSourceId 复制同类冻结样式；原始规则模式应复用经 author.css 证实的现有 class，必要时在 author-overrides.css 为新 sourceId 增加局部样式。不得假设 flex、间距或垂直居中的工具类存在。',
  '新增控件前必须记录父容器宽高、布局方向、换行策略和兄弟元素矩形；新增后可再次批量 inspect 同一容器核对源码结构和预期容器关系。inspect 返回的是捕获或源码布局上下文，不能证明候选页没有换行、溢出、遮挡或裁切；这类真实渲染结论只能由后续浏览器几何验证产生，finish 前不得声称已经验证。若空间不足，必须调整为可容纳的布局方案后再 finish，不能仅以 HTML/CSS 存在作为通过。',
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
  '任何源码写入前必须先调用 declare_intent，明确目标、现有相关 sourceId、验证所需 sourceId、视觉约束和歧义判断。不得搜索、推算或预填尚未创建的 sourceId；系统会在创建后自动把新节点加入验证范围。renderConstraintIndexes 只列出可以由当前浏览器几何直接证明的约束序号；“其他元素未受影响”这类需要修改前基线的约束应保留为修改范围，不作为当前渲染发布门槛。仍有多个合理结果时不要调用 declare_intent，直接 clarify。',
  '如果请求包含 replyToClarificationId，应把当前 instruction 理解为用户对上一条澄清问题的回答，并结合 conversation 继续原需求，不要重复询问已经回答的信息。',
  '优先复用已有结构和 class；新增同类组件时复制相邻源码结构，再修改必要内容。',
  '不得添加 script、事件属性、远程资源、接口请求、表单 action 或 javascript: URL。',
  CONTROLLED_INTERACTION_INSTRUCTIONS,
  '每次修改后检查工具结果；目标达成后先调用 validate_workspace。若提示元素被 overflow 裁剪，必须调整父容器尺寸、overflow 或定位，不能直接声明完成。',
  'finish 只会生成等待真实渲染验证的候选草稿，不会发布正式 Revision。若本轮无需改动，先调用 declare_intent 和 validate_workspace；随后调用 finish，并明确 outcome=already_satisfied，同时写明源码证据。不得把未验证的猜测当作已满足。',
  '不要只用自然语言声称生成草稿。没有调用 finish 或 clarify，本轮就不算完成。',
  '不要做与用户请求无关的重构。'
].join('\n');

const DEFAULT_MAX_ITERATIONS = 45;
const MAX_BATCH_INSPECTION_CHARS = 12_000;
const MAX_BATCH_ELEMENT_CHARS = 4_000;
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
  'list_files', 'query_workspace_structure', 'search_text', 'read_file', 'inspect_element', 'inspect_elements',
  'query_style_symbols', 'read_style_rule', 'read_style_rules'
]);

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
    const modeRules = clineSourceRules.replace(
      'finish 只会生成等待真实渲染验证的候选草稿，不会发布正式 Revision。', finishDescription
    );
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
    const compactInspectedSourceIds = new Set<string>();
    const changedPositioningClassNames = new Set<string>();
    const repeatedFailures = new Map<string, number>();
    const readActionCounts = new Map<string, number>();
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
        const message = `[运行预算] 当前第 ${context.iteration}/${this.maxIterations} 轮，已进入最后 ${FINALIZATION_WINDOW} 轮，停止继续读取。若修改已完成，请立即调用 validate_workspace 后 finish；若关键信息仍不足，请调用 clarify。`;
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
        if (['replace_text', 'apply_patch', 'set_element_text', 'set_element_attributes',
          'insert_element', 'wrap_element', 'unwrap_element', 'remove_element',
          'reorder_children', 'apply_dom_operations', 'move_element', 'clone_element'].includes(action)) {
          completedReadResults.clear();
          readActionCounts.clear();
        }
        if (readKey) completedReadResults.set(readKey, result);
        throwIfCancelled();
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

    const registerNewSourceId = (sourceId: string) => {
      newSourceIds.add(sourceId);
      if (declaredIntent && !declaredIntent.sourceIds.includes(sourceId)) {
        declaredIntent = { ...declaredIntent, sourceIds: [...declaredIntent.sourceIds, sourceId] };
      }
    };

    const trackNewSourceIds = (before: string, after: string) => {
      const existing = sourceIdsIn(before);
      let changed = false;
      for (const sourceId of sourceIdsIn(after)) {
        if (existing.has(sourceId)) continue;
        registerNewSourceId(sourceId);
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
          verificationSourceIds: {
            type: 'array', minItems: 1, maxItems: 40,
            items: stringProperty('真实浏览器必须测量的 sourceId。包括目标、容器和每个用于证明约束成立的相关元素。')
          },
          visualConstraints: {
            type: 'array', maxItems: 20,
            items: stringProperty('修改后必须成立的视觉或结构约束。')
          },
          renderConstraintIndexes: {
            type: 'array', minItems: 1, maxItems: 20,
            items: { type: 'integer', minimum: 1 },
            description: 'visualConstraints 中可由当前浏览器几何或计算样式直接验证的约束序号（从 1 开始）。颜色等样式目标也必须列入；每个候选至少列出一项；仅作为修改范围说明的约束不要列入。'
          },
          layoutScope: { type: 'string', enum: ['selected-context', 'explicit-container', 'global'] },
          ambiguityAssessment: stringProperty('说明为何当前信息足以得到唯一方案；不得用来掩盖未解决歧义。')
        }, ['summary', 'verificationSourceIds', 'renderConstraintIndexes', 'ambiguityAssessment']),
        execute: (input, context) => execute(
          'declare_intent',
          input,
          context,
          async () => {
            const sourceIds = [...new Set([...(input.relevantSourceIds ?? []), ...(input.verificationSourceIds ?? [])])];
            const constraints = [...new Set(input.visualConstraints ?? [])];
            const renderConstraintIndexes = [...new Set(input.renderConstraintIndexes ?? [])];
            if (!sourceIds.length) {
              throw new Error('declare_intent 必须列出至少一个实际相关的 sourceId；请先查询并检查目标结构，无法定位时调用 clarify');
            }
            if (!constraints.length) {
              throw new Error('declare_intent 必须列出至少一条需求约束；请明确修改后应成立的内容、布局或可见性要求');
            }
            if (!renderConstraintIndexes.length) {
              throw new Error('declare_intent 必须列出至少一条可由当前浏览器观察直接验证的约束；仅作修改范围说明的约束不能作为候选发布依据');
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
        description: '按 data-ui-source-id 读取页面元素的局部源码、文字和样式线索。默认 compact；只有精简结果不足以判断时才使用 full。',
        inputSchema: objectSchema({
          sourceId: stringProperty('元素的 data-ui-source-id。'),
          detail: { type: 'string', enum: ['compact', 'full'] }
        }, ['sourceId']),
        execute: (input, context) => {
          const detail = input.detail ?? 'compact';
          if (detail === 'full' && !compactInspectedSourceIds.has(input.sourceId)) {
            const message = `[展开条件] 必须先对 ${input.sourceId} 执行 compact 检查；只有精简结果缺少完成当前判断所需的信息时，才能请求 full。`;
            // This is a workflow correction, not a completed read. Keeping it
            // out of the completed-read cache lets the required compact read
            // and the subsequent full read proceed normally.
            record('inspect_element', input, context, message, undefined, true, 'blocked');
            return Promise.resolve(message);
          }
          return execute(
            'inspect_element',
            input,
            context,
            async () => {
              const result = await workspace.inspectElement(input.sourceId, { detail });
              if (detail === 'compact') compactInspectedSourceIds.add(input.sourceId);
              return result;
            }
          );
        }
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
              compactInspectedSourceIds.add(sourceId);
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
      createTool<{
        summary: string;
        outcome?: 'changed' | 'already_satisfied';
        evidence?: string;
        requirementReview?: RequirementReview;
      }, string>({
        name: 'finish',
        description: `${finishDescription}若当前副本无需改动，设置 outcome=already_satisfied，并提供源码证据。`,
        inputSchema: objectSchema({
          summary: stringProperty('面向用户的简洁修改说明。'),
          requirementReview: objectSchema({
            originalRequestReviewed: { type: 'boolean', const: true, description: '已重新核对原始请求及澄清，而非只检查声明列表。' },
            missingRequirements: { type: 'array', items: stringProperty('原始请求中未覆盖或尚未实现的要求；存在任何缺项禁止提交。') },
            checks: { type: 'array', minItems: 1, items: objectSchema({
              constraintIndex: { type: 'integer', minimum: 1 },
              status: { type: 'string', enum: ['implemented', 'unsupported', 'incomplete'] },
              evidence: stringProperty('该约束的具体实现证据，例如节点、属性、样式及工具结果；不得伪造渲染结论。')
            }, ['constraintIndex', 'status', 'evidence']) }
          }, ['originalRequestReviewed', 'missingRequirements', 'checks']),
          outcome: {
            type: 'string',
            enum: ['changed', 'already_satisfied'],
            description: '本轮是否产生了源码修改；默认 changed。'
          },
          evidence: stringProperty('仅 outcome=already_satisfied 时填写：说明已读取和验证的当前源码证据。')
        }, ['summary', 'requirementReview']),
        lifecycle: { completesRun: true },
        execute: async (input, context) => {
          try {
            throwIfCancelled();
            if (clarificationRequested || completion?.kind === 'clarification') {
              throw new Error('本轮已进入等待用户澄清状态，禁止提交；请等待用户回复后开启新一轮执行');
            }
            requireIntentDeclared();
            validateRequirementReview(input.requirementReview, declaredIntent?.constraints.length ?? 0);
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
      throwIfCancelled();
      activeAgent = this.factory({
        providerId: 'openai-compatible',
        modelId: this.options.modelName,
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
        systemPrompt: `${modeRules}\n单轮最多 ${this.maxIterations} 次模型决策；从第 ${Math.max(1, this.maxIterations - FINALIZATION_WINDOW + 1)} 轮起必须停止扩展读取，只能完成必要修改、校验并 finish，或 clarify。`,
        tools,
        maxIterations: this.maxIterations
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
        files
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
          summary: `${completion.summary}（${completion.validation}）`,
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
        rollback: rollbackStatus
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
  return new ClineCodingAgentAdapter({
    baseUrl: env.MODEL_BASE_URL,
    apiKey: env.MODEL_API_KEY,
    modelName: env.MODEL_NAME,
    maxIterations: parsedMaxIterations
  });
}
