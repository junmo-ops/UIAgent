import { createOpenAI } from '@ai-sdk/openai';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from 'ai';
import { z, ZodError } from 'zod';
import {
  PROTOCOL_VERSION,
  plannerResultSchema,
  type ChangePlan,
  type DomTreeNode,
  type PlannerResult,
  type StartTurnRequest,
  type UIChangeOperation,
  type UiIntent
} from '@ui-agent/contracts';
import { compilePlanFromIntent, intentFromOperations, IntentCompilationError } from '@ui-agent/domain';

export interface Planner {
  plan(request: StartTurnRequest, conversation?: ConversationTurn[]): Promise<PlannerResult>;
}

export interface AgentRuntime {
  invoke(request: StartTurnRequest): Promise<PlannerResult>;
}

export interface ConversationTurn {
  instruction: string;
  result: PlannerResult;
}

export type RuntimeTraceEvent =
  | {
      type: 'turn.started';
      timestamp: string;
      request: StartTurnRequest;
      conversation: ConversationTurn[];
    }
  | {
      type: 'turn.completed';
      timestamp: string;
      request: StartTurnRequest;
      conversation: ConversationTurn[];
      result: PlannerResult;
      durationMs: number;
    }
  | {
      type: 'turn.failed';
      timestamp: string;
      request: StartTurnRequest;
      conversation: ConversationTurn[];
      error: string;
      durationMs: number;
    }
  | {
      type: 'model.attempt.completed';
      timestamp: string;
      request: StartTurnRequest;
      attempt: number;
      durationMs: number;
      promptChars: number;
      systemChars: number;
      repairReason?: string;
      error?: string;
    }
  | {
      type: 'model.attempt.failed';
      timestamp: string;
      request: StartTurnRequest;
      attempt: number;
      durationMs: number;
      promptChars: number;
      systemChars: number;
      repairReason?: string;
      error?: string;
    };

export type RuntimeTraceObserver = (event: RuntimeTraceEvent) => void;

const plannerRules = [
  '你是 UI Change Planner，只能返回指定结构的 JSON。',
  '先把用户需求表达成 plan.intent.goals，再为每个目标生成通用 DOM 原子操作；目标描述最终页面事实，操作只描述实现手段。',
  '每个 create goal 必须设置 resultRef，并与一个 addComponent 或 cloneSubtree 操作的 resultRef 一致。',
  'goal.content 表达组件内容和语义变体；goal.placement 表达严格相对位置和同行约束；goal.state 表达展开、选中或禁用状态；preserveTexts 表达必须保持的页面内容。',
  '操作计划必须忠实实现 intent，不允许通过降低组件语义、改变位置或忽略状态来简化目标。',
  '把业务需求拆解为 Schema 中的通用 DOM 原子操作，不要创造订单行、筛选栏等业务操作类型。',
  'selectedTree 是选区局部结构；reusableTrees 是从选区内识别出的可复用结构模板。二者均可读取、复制和作为插入锚点。',
  'currentContext.contextScopes 表示本轮已经提供的扩展上下文。基础上下文始终包含选中元素、最小子树、直接父级和 elementIndex 轻量元素索引。',
  'elementIndex 只用于识别局部元素及其 nodeId。需要某个具体元素的完整可见样式时，申请 visibleStyles，并在 contextRequest.targetNodeIds 中列出该元素 ID；不要为获取样式申请整个 elementFacts。',
  '如果生成可靠计划确实需要尚未提供的相邻元素、可复用结构、详细布局事实、完整可见样式或本会话新增结构，返回 contextRequest，并只申请必要 scopes。',
  '可申请的 scopes 为 siblings、visibleStyles、reusableStructures、elementFacts、sessionChanges。不得重复申请 currentContext.contextScopes 已包含的 scope。',
  '缺少页面结构时优先申请 contextRequest；只有缺少用户业务意图或输入内容时才返回 clarification。',
  '只有 selected.id、addedTrees 和计划内结果可直接修改。相邻元素只能读取。',
  '有现成重复结构时优先使用 cloneSubtree，再用 resultRef 和 path 修改复制节点。锚点必须是能严格表达最终相对位置且符合 HTML 父子约束的实际节点。',
  '如果 selectedTree 或 reusableTrees 已明确包含重复结构，不要再向用户确认 DOM 结构，直接基于可见结构生成计划。',
  '用户要求随机生成、使用默认值或由你决定时，应自行生成合理的静态示例文案，不要继续追问字段值。',
  '组件角色由基础能力目录约束：button、text、link、input、select、checkboxGroup、radioGroup、tag、alert；结构复制使用 field、row 或 container 目标。',
  '组件的 label、placeholder、options、variant 和 state 必须同时写入 intent；执行操作中的 props 由目标编译器统一校准。',
  '用户要求新元素或已有元素与另一个元素外观一致时，在对应 goal.appearance 中声明 mode=match 和 source；不要猜测或手写 CSS，领域编译器会生成受控 copyStyles 操作。',
  '不要通过向一个容器追加纯文本来伪造表格行、列表项或其他结构。',
  '不输出 HTML、JavaScript、选择器、网络请求、导航或事件处理器。',
  '删除已有选中元素时 requiresConfirmation 必须为 true。',
  '信息不足、意图模糊或越界时返回 clarification。',
  `protocolVersion 固定为 ${PROTOCOL_VERSION}。`
];

const plannerJsonSchema = JSON.stringify(z.toJSONSchema(plannerResultSchema));

function createPlannerPrompt(request: StartTurnRequest, conversation: ConversationTurn[]): string {
  return JSON.stringify({
    conversationHistory: conversation,
    currentInstruction: request.instruction,
    currentContext: request.context
  });
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function extractQuotedValues(input: string): string[] {
  const values = [...input.matchAll(/[“\"']([^”\"']+)[”\"']/g)].map(match => match[1]!).filter(Boolean);
  if (values.length) return values;
  const marker = input.match(/(?:包括|选项(?:为|有)?|内容(?:为|有)?)[：:]?(.+)/);
  return marker?.[1]?.split(/[、，,]/).map(value => value.trim()).filter(Boolean).slice(0, 12) ?? [];
}

function extractAddedLabel(input: string): string | undefined {
  return input.match(/(?:增加|添加|新增)(?:一个|一项)?([^，,]+?)(?=[，,]|选项|$)/)?.[1]
    ?.replace(/(?:筛选项|下拉框|选择器|输入框|输入项)$/, '')
    .trim() || undefined;
}

function createPlan(request: StartTurnRequest, operations: UIChangeOperation[], summary: string): PlannerResult {
  const normalizedOperations = operations.map(operation =>
    operation.type === 'addComponent' && !operation.resultRef
      ? { ...operation, resultRef: `result-${operation.operationId}` }
      : operation
  );
  const removesExisting = normalizedOperations.some(operation => operation.type === 'removeElement' && operation.target.kind === 'node');
  const plan: ChangePlan & { intent: UiIntent } = {
    protocolVersion: PROTOCOL_VERSION,
    planId: id('plan'),
    selectionVersion: request.context.selectionVersion,
    pageRevision: request.context.pageRevision,
    summary,
    intent: intentFromOperations(summary, normalizedOperations),
    requiresConfirmation: removesExisting,
    operations: normalizedOperations
  };
  return { kind: 'plan', plan: compilePlanFromIntent(plan, request.context) };
}

const MIN_NODE_ID_PREFIX_LENGTH = 8;

function contextNodeIds(request: StartTurnRequest): string[] {
  const ids = new Set<string>();
  const visit = (node: DomTreeNode) => {
    ids.add(node.id);
    node.children.forEach(visit);
  };
  visit(request.context.selectedTree);
  request.context.reusableTrees.forEach(visit);
  request.context.addedTrees.forEach(visit);
  request.context.elementIndex?.forEach(entry => ids.add(entry.id));
  request.context.elementFacts?.forEach(entry => ids.add(entry.id));
  return [...ids];
}

function resolveNodeId(reference: string, availableIds: string[]): string {
  if (availableIds.includes(reference) || reference.length < MIN_NODE_ID_PREFIX_LENGTH) return reference;
  const matches = availableIds.filter(id => id.startsWith(reference));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new IntentCompilationError(`节点引用 ${reference} 匹配到多个局部元素，请使用完整 nodeId`);
  }
  return reference;
}

function normalizeNodeReferences<T>(value: T, availableIds: string[]): T {
  if (Array.isArray(value)) {
    return value.map(item => normalizeNodeReferences(item, availableIds)) as T;
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.kind === 'node' && typeof record.nodeId === 'string') {
    return { ...record, nodeId: resolveNodeId(record.nodeId, availableIds) } as T;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, normalizeNodeReferences(item, availableIds)])
  ) as T;
}

/**
 * A model should not guess deep paths inside framework component DOM. When a
 * page explicitly exposes a semantic component template, collapse a fragile
 * clone-and-edit sequence into the controlled component macro.
 */
export function compilePlannerResult(request: StartTurnRequest, result: PlannerResult): PlannerResult {
  const availableIds = contextNodeIds(request);
  if (result.kind === 'contextRequest') {
    return {
      ...result,
      contextRequest: {
        ...result.contextRequest,
        targetNodeIds: result.contextRequest.targetNodeIds?.map(nodeId => resolveNodeId(nodeId, availableIds))
      }
    };
  }
  if (result.kind !== 'plan') return result;
  const normalizedPlan = normalizeNodeReferences(result.plan, availableIds);
  return { kind: 'plan', plan: compilePlanFromIntent(normalizedPlan, request.context) };
}

export class MockPlanner implements Planner {
  async plan(request: StartTurnRequest, conversation: ConversationTurn[] = []): Promise<PlannerResult> {
    const input = request.instruction.trim();
    const recentAdded = request.context.addedElements.at(-1);
    const refersToRecent = /刚才|新增|新加|这个(?:筛选|按钮|链接|输入|选项)/.test(input);
    const targetId = refersToRecent && recentAdded ? recentAdded.id : request.context.selected.id;
    const target = { kind: 'node' as const, nodeId: targetId };
    const operationId = id('op');
    const values = extractQuotedValues(input);

    if (/删除|移除/.test(input)) {
      return createPlan(request, [{ operationId, type: 'removeElement', target }], `删除已选中的“${request.context.selected.text || request.context.selected.tag}”`);
    }

    if (/改成|修改.*文案|文字改/.test(input)) {
      const text = values.at(-1) ?? input.match(/(?:改成|修改为|变成)[：:]?\s*(.+)$/)?.[1]?.trim();
      if (!text) return this.clarify('没有识别到目标文案', '请明确说明要把文案修改成什么内容。');
      return createPlan(request, [{ operationId, type: 'updateContent', target, text }], `将选中元素的文案修改为“${text}”`);
    }

    if (/颜色|背景|红色|蓝色|绿色/.test(input) && !/添加|增加|新增/.test(input)) {
      const color = /红/.test(input) ? '#ff4d4f' : /绿/.test(input) ? '#52c41a' : '#1677ff';
      const property = /背景/.test(input) ? 'backgroundColor' : 'color';
      return createPlan(request, [{ operationId, type: 'updateStyle', target, styles: { [property]: color } }], `修改选中元素的${property === 'color' ? '文字' : '背景'}颜色`);
    }

    const position = /左侧|前面|之前/.test(input) ? 'before' as const : /内部|里面/.test(input) ? 'insideEnd' as const : 'after' as const;
    if (/筛选|下拉|选择器/.test(input)) {
      const options = values.length ? values : ['全部', '待处理', '已完成'];
      const label = extractAddedLabel(input);
      return createPlan(request, [{ operationId, type: 'addComponent', anchor: target, component: 'select', position, props: { label, placeholder: label ? `请选择${label}` : '请选择', options } }], '在选中元素旁新增下拉筛选项');
    }
    if (/多选|复选/.test(input)) {
      return createPlan(request, [{ operationId, type: 'addComponent', anchor: target, component: 'checkboxGroup', position, props: { options: values.length ? values : ['选项 A', '选项 B'] } }], '新增一组多选项');
    }
    if (/单选/.test(input)) {
      return createPlan(request, [{ operationId, type: 'addComponent', anchor: target, component: 'radioGroup', position, props: { options: values.length ? values : ['选项 A', '选项 B'] } }], '新增一组单选项');
    }
    if (/按钮/.test(input)) {
      return createPlan(request, [{ operationId, type: 'addComponent', anchor: target, component: 'button', position, props: { text: values[0] ?? '新按钮' } }], '新增按钮');
    }
    if (/链接/.test(input)) {
      return createPlan(request, [{ operationId, type: 'addComponent', anchor: target, component: 'link', position, props: { text: values[0] ?? '查看详情', href: '#demo-link' } }], '新增链接');
    }
    if (/输入框|输入项/.test(input)) {
      return createPlan(request, [{ operationId, type: 'addComponent', anchor: target, component: 'input', position, props: { placeholder: values[0] ?? '请输入' } }], '新增输入框');
    }
    if (/文字|文本|提示/.test(input)) {
      return createPlan(request, [{ operationId, type: 'addComponent', anchor: target, component: 'text', position, props: { text: values[0] ?? '新增说明文字' } }], '新增文字说明');
    }

    return this.clarify('指令中缺少可执行的组件或修改类型', '请说明要添加、修改或删除什么，例如“在它右侧添加一个包含待审核、已通过的筛选项”。');
  }

  private clarify(reason: string, question: string): PlannerResult {
    return { kind: 'clarification', clarification: { protocolVersion: PROTOCOL_VERSION, reason, question } };
  }
}

export class AiSdkPlanner implements Planner {
  private readonly provider;
  constructor(
    baseURL: string,
    apiKey: string,
    private readonly modelName: string,
    private readonly observe?: RuntimeTraceObserver
  ) {
    this.provider = createOpenAI({ baseURL, apiKey });
  }

  async plan(request: StartTurnRequest, conversation: ConversationTurn[] = []): Promise<PlannerResult> {
    const system = plannerRules.join('\n');
    const prompt = createPlannerPrompt(request, conversation);
    const startedAt = Date.now();
    try {
      const { output } = await generateText({
        model: this.provider.chat(this.modelName),
        output: Output.object({ schema: plannerResultSchema }),
        maxRetries: 0,
        system,
        prompt
      });
      if (!output) throw new Error('模型没有返回结构化结果');
      const result = compilePlannerResult(request, plannerResultSchema.parse(output));
      this.traceModelAttempt('model.attempt.completed', request, 1, startedAt, prompt, system);
      return result;
    } catch (error) {
      this.traceModelAttempt('model.attempt.failed', request, 1, startedAt, prompt, system, undefined, error);
      throw error;
    }
  }

  private traceModelAttempt(
    type: 'model.attempt.completed' | 'model.attempt.failed',
    request: StartTurnRequest,
    attempt: number,
    startedAt: number,
    prompt: string,
    system: string,
    repairReason?: string,
    error?: unknown
  ) {
    this.observe?.({
      type,
      timestamp: new Date().toISOString(),
      request,
      attempt,
      durationMs: Date.now() - startedAt,
      promptChars: prompt.length,
      systemChars: system.length,
      repairReason,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
    });
  }
}

/**
 * DeepSeek currently documents JSON Object mode, but not OpenAI's JSON Schema
 * response format. Ask the provider for valid JSON, then enforce our schema
 * locally so the executor never receives an unchecked model response.
 */
export class DeepSeekPlanner implements Planner {
  private readonly provider;

  constructor(
    baseURL: string,
    apiKey: string,
    private readonly modelName: string,
    private readonly observe?: RuntimeTraceObserver
  ) {
    this.provider = createOpenAI({ name: 'deepseek', baseURL, apiKey });
  }

  async plan(request: StartTurnRequest, conversation: ConversationTurn[] = []): Promise<PlannerResult> {
    try {
      return await this.generatePlan(request, conversation, undefined, 1);
    } catch (error) {
      if (
        !NoObjectGeneratedError.isInstance(error)
        && !NoOutputGeneratedError.isInstance(error)
        && !(error instanceof ZodError)
        && !(error instanceof IntentCompilationError)
      ) throw error;
      const reason = error instanceof IntentCompilationError
        ? `上一次 Intent 与操作计划不一致：${error.message}`
        : NoOutputGeneratedError.isInstance(error)
          ? '上一次响应没有生成可解析的输出。'
        : '上一次响应不是有效的目标 JSON。';
      return this.generatePlan(
        request,
        conversation,
        `${reason} 请重新生成，确保每个 Goal 都有可执行操作，只返回一个符合 Schema 的 JSON 对象。`,
        2
      );
    }
  }

  private async generatePlan(
    request: StartTurnRequest,
    conversation: ConversationTurn[],
    repairInstruction?: string,
    attempt = 1
  ): Promise<PlannerResult> {
    const system = [
      ...plannerRules,
      '必须只输出 JSON 对象，不要输出 Markdown、代码块或额外解释。',
      `JSON Schema：${plannerJsonSchema}`,
      ...(repairInstruction ? [repairInstruction] : [])
    ].join('\n');
    const prompt = createPlannerPrompt(request, conversation);
    const startedAt = Date.now();
    try {
      const { output } = await generateText({
        model: this.provider.chat(this.modelName),
        output: Output.json(),
        maxOutputTokens: 4096,
        maxRetries: 0,
        system,
        prompt
      });
      if (!output) throw new Error('DeepSeek 没有返回 JSON 结果');
      const result = compilePlannerResult(request, plannerResultSchema.parse(output));
      this.traceModelAttempt('model.attempt.completed', request, attempt, startedAt, prompt, system, repairInstruction);
      return result;
    } catch (error) {
      this.traceModelAttempt('model.attempt.failed', request, attempt, startedAt, prompt, system, repairInstruction, error);
      throw error;
    }
  }

  private traceModelAttempt(
    type: 'model.attempt.completed' | 'model.attempt.failed',
    request: StartTurnRequest,
    attempt: number,
    startedAt: number,
    prompt: string,
    system: string,
    repairReason?: string,
    error?: unknown
  ) {
    this.observe?.({
      type,
      timestamp: new Date().toISOString(),
      request,
      attempt,
      durationMs: Date.now() - startedAt,
      promptChars: prompt.length,
      systemChars: system.length,
      repairReason,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
    });
  }
}

const GraphState = Annotation.Root({
  request: Annotation<StartTurnRequest>(),
  result: Annotation<PlannerResult>(),
  conversation: Annotation<ConversationTurn[]>({
    reducer: (current, update) => [...current, ...update].slice(-8),
    default: () => []
  })
});

export function createAgentRuntime(planner: Planner, observe?: RuntimeTraceObserver): AgentRuntime {
  const emit = (event: RuntimeTraceEvent) => {
    try { observe?.(event); }
    catch (error) { console.error('[agent-runtime] trace observer failed', error); }
  };
  const graph = new StateGraph(GraphState)
    .addNode('plan', async state => {
      const startedAt = Date.now();
      emit({ type: 'turn.started', timestamp: new Date(startedAt).toISOString(), request: state.request, conversation: state.conversation });
      try {
        const result = await planner.plan(state.request, state.conversation);
        emit({
          type: 'turn.completed', timestamp: new Date().toISOString(), request: state.request,
          conversation: state.conversation, result, durationMs: Date.now() - startedAt
        });
        return {
          result,
          // Context expansion is an internal planning step, not a user conversation turn.
          conversation: result.kind === 'contextRequest'
            ? []
            : [{ instruction: state.request.instruction, result }]
        };
      } catch (error) {
        emit({
          type: 'turn.failed', timestamp: new Date().toISOString(), request: state.request,
          conversation: state.conversation,
          error: error instanceof Error ? error.message : '未知错误', durationMs: Date.now() - startedAt
        });
        throw error;
      }
    })
    .addEdge(START, 'plan')
    .addEdge('plan', END)
    .compile({ checkpointer: new MemorySaver() });

  return {
    async invoke(request: StartTurnRequest): Promise<PlannerResult> {
      const state = await graph.invoke(
        { request },
        { configurable: { thread_id: request.editSessionId } }
      );
      return state.result;
    }
  };
}

export function plannerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  observe?: RuntimeTraceObserver
): Planner {
  if (env.MODEL_MODE !== 'remote') return new MockPlanner();
  if (!env.MODEL_BASE_URL || !env.MODEL_API_KEY || !env.MODEL_NAME) {
    throw new Error('MODEL_MODE=remote 时必须设置 MODEL_BASE_URL、MODEL_API_KEY 和 MODEL_NAME');
  }
  if (env.MODEL_PROVIDER === 'deepseek') {
    return new DeepSeekPlanner(env.MODEL_BASE_URL, env.MODEL_API_KEY, env.MODEL_NAME, observe);
  }
  return new AiSdkPlanner(env.MODEL_BASE_URL, env.MODEL_API_KEY, env.MODEL_NAME, observe);
}

export {
  SourceEditingAgent,
  sourceEditingAgentFromEnvironment,
  type SourceAgentTraceStep,
  type SourceConversationTurn,
  type SourceDecisionMaker,
  type SourceFileTools
} from './source-agent';
export {
  type CodingAgentCheckpoint,
  type CodingAgentConversationTurn,
  type CodingAgentEvent,
  type CodingAgentObserver,
  type CodingAgentPort,
  type CodingAgentRunResult,
  type CodingAgentStep,
  type CodingAgentTurn,
  type CodingWorkspaceTools
} from './coding-agent-port';
export {
  LegacyCodingAgentAdapter,
  codingAgentPortFromEnvironment
} from './legacy-coding-agent-adapter';
export {
  ClineCodingAgentAdapter,
  clineCodingAgentFromEnvironment,
  type ClineAgentFactory,
  type ClineAgentFactoryInput,
  type ClineAgentInstance,
  type ClineCodingAgentOptions
} from './cline-coding-agent-adapter';
