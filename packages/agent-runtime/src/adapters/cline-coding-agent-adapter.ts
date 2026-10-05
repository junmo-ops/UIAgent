import { createValidatedTool as createTool } from './validated-tool';
import type { SkillProvider } from '../core/skill-port';
import { reviewSourceImplementation, type SourceReviewResult } from './source-review';
import { skillTools } from './skill-tools';
import { createCommentaryLocalizer, needsCommentaryLocalization } from './commentary-localizer';
import { editModePolicy } from './edit-mode-policy';
import { RESPONSE_LANGUAGE_INSTRUCTIONS } from './response-language-instructions';
import {
  Agent,
  type AgentRunResult,
  type AgentTool,
  type AgentToolContext
} from '../../vendor/ui-agent-runtime/index.js';
import { createHash, randomUUID } from 'node:crypto';
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

function summarizeLayoutChange(change: {
  action: string; input: unknown; operationId: string; toolCallId?: string;
}) {
  let truncated = false;
  const summarize = (value: unknown): unknown => {
    // Original arguments remain in model history and the full source-step log.
    // Retain small style edits and structural parameters; do not resend large
    // JSX/HTML bodies or turn a partial code snippet into apparent evidence.
    if (typeof value === 'string' && value.length > 240) {
      truncated = true;
      return { omitted: true, chars: value.length, sha256: createHash('sha256').update(value).digest('hex') };
    }
    if (Array.isArray(value)) return value.map(summarize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, summarize(child)]));
    }
    return value;
  };
  const serialized = JSON.stringify(change.input);
  const inputSummary = summarize(change.input);
  return {
    operationId: change.operationId, action: change.action, toolCallId: change.toolCallId,
    inputChars: serialized.length, inputSha256: createHash('sha256').update(serialized).digest('hex'),
    inputSummary, truncated
  };
}

function boundedInspection(result: string, budget: number, seenLayout: Set<string>): string {
  const maxChars = budget;
  budget = Math.max(0, budget - 400); // Reserve headings and omission notices.
  const clip = (value: string, limit: number) => value.length <= limit ? value
    : `${value.slice(0, Math.max(0, limit - 40))}\n[本项已省略部分内容；按需定向读取]`;
  const lines = result.split('\n');
  const layoutLine = lines.find(line => line.startsWith('布局上下文: '));
  const path = (lines.find(line => line.startsWith('结构路径: ')) ?? '').slice('结构路径: '.length)
    .split(' > ').filter(Boolean);
  const parents = new Map<string, string>();
  const pathIds = path.map(node => node.split('<')[0]!);
  pathIds.forEach((id, index) => { if (index) parents.set(id, pathIds[index - 1]!); });
  const pathLimit = Math.floor(budget * 0.1);
  const retainedPath = [...path];
  const pathText = () => `结构路径: ${path.length > retainedPath.length ? `[前 ${path.length - retainedPath.length} 项已省略] > ` : ''}${retainedPath.join(' > ')}`;
  // A deep path must keep the actual target end, not only distant ancestors.
  while (retainedPath.length > 1 && pathText().length > pathLimit) retainedPath.shift();
  const sourceStart = result.indexOf('domText: ');
  const styleStart = result.indexOf('组件与样式上下文:');
  const source = [
    clip(lines.find(line => line.startsWith('domText: ')) ?? '', Math.floor(budget * 0.07)),
    clip(lines.find(line => line.startsWith('compactHtml: ')) ?? '', Math.floor(budget * 0.23))
  ].filter(Boolean).join('\n');
  const styles = styleStart >= 0 ? result.slice(styleStart, sourceStart >= 0 ? sourceStart : undefined) : '';
  const prefix = [
    clip(lines[0] ?? '', 180),
    path.length ? clip(pathText(), pathLimit) : '结构路径: 未提供',
    '源码摘要（非精确原文；精确替换请按字符范围 read_file）：',
    source,
    clip(styles, Math.floor(budget * 0.15))
  ].filter(Boolean).join('\n');
  const layoutHeading = '布局上下文（捕获值不是修改后的渲染测量；inlineStyle 是当前源码声明；partial 或未列出的事实需按需读取，不能视为不存在）: ';
  const omissionLimit = 200;
  const layoutBudget = Math.max(2, maxChars - prefix.length - layoutHeading.length - omissionLimit - 3);
  const layout: Record<string, unknown> = {};
  const omissions: string[] = [];
  const stripRepeatedNotes = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripRepeatedNotes);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      if (key === 'cascadeNote') return [];
      if (key === 'layoutEvidence') return typeof child === 'string' && child.startsWith('unavailable')
        ? [['layoutUnavailable', true]] : [];
      return [[key, stripRepeatedNotes(child)]];
    }));
  };
  const compactFact = (original: Record<string, unknown>, limit: number): Record<string, unknown> | undefined => {
    const fact = stripRepeatedNotes(original) as Record<string, unknown>;
    if (typeof fact.sourceId === 'string' && parents.has(fact.sourceId)) fact.parentSourceId = parents.get(fact.sourceId);
    if (JSON.stringify(fact).length <= limit) return fact;
    const node: Record<string, unknown> = {
      sourceId: fact.sourceId, tag: fact.tag, parentSourceId: fact.parentSourceId, partial: true
    };
    if (JSON.stringify(node).length > limit) return undefined;
    const add = (key: string, value: unknown) => {
      if (value !== undefined && JSON.stringify({ ...node, [key]: value }).length <= limit) node[key] = value;
    };
    add('capturedRect', fact.capturedRect);
    add('layoutUnavailable', fact.layoutUnavailable);
    // Preserve layout mechanism before long dimensions or optional metadata.
    const computed = (fact.computedLayout ?? {}) as Record<string, unknown>;
    const properties = [...new Set(['display', 'position', 'overflow', 'overflow-x', 'overflow-y',
      'box-sizing', 'width', 'height', 'flex-direction', 'flex-wrap', 'flex-basis', 'flex-shrink',
      'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'gap', ...Object.keys(computed)])];
    for (const property of properties) {
      if (computed[property] !== undefined) add('computedLayout', {
        ...(node.computedLayout as Record<string, unknown> ?? {}), [property]: computed[property]
      });
    }
    add('inlineStyle', fact.inlineStyle);
    return node;
  };
  const append = (kind: string, node: unknown, array: boolean): boolean => {
    const candidate = { ...layout, [kind]: array ? [...(layout[kind] as unknown[] ?? []), node] : node };
    if (JSON.stringify(candidate).length > layoutBudget) return false;
    layout[kind] = candidate[kind];
    return true;
  };
  const available = () => Math.max(0, layoutBudget - JSON.stringify(layout).length - 40);
  if (layoutLine) {
    const facts = JSON.parse(layoutLine.slice('布局上下文: '.length)) as Record<string, unknown>;
    if (facts.capturedViewport) append('capturedViewport', facts.capturedViewport, false);
    // Keep current direct-child order separate from captured rectangles and
    // verbose child style facts, which may consume the remaining budget.
    if (facts.currentSourceStructure && !append('currentSourceStructure', facts.currentSourceStructure, false)) {
      omissions.push('currentSourceStructure（预算不足）');
    }
    // Keep measured neighboring rectangles before verbose target/ancestor
    // styles consume the budget. These are evidence, not placement decisions.
    const neighborGroups = ['children', 'siblings'] as const;
    const neighbors = Object.fromEntries(neighborGroups.map(kind => [kind,
      (Array.isArray(facts[kind]) ? facts[kind] : []) as Record<string, unknown>[]
    ])) as Record<typeof neighborGroups[number], Record<string, unknown>[]>;
    const capturedNeighborRects: Record<typeof neighborGroups[number], Record<string, unknown>[]> = {
      children: [], siblings: []
    };
    const neighborBudget = Math.floor(available() * 0.25);
    // Interleave groups so a long child list cannot hide all sibling evidence.
    for (let index = 0; index < Math.max(neighbors.children.length, neighbors.siblings.length); index++) {
      for (const kind of neighborGroups) {
        const original = neighbors[kind][index];
        if (!original) continue;
        const rect = { sourceId: original.sourceId,
          parentSourceId: typeof original.sourceId === 'string'
            ? parents.get(original.sourceId) ?? original.parentSourceId : original.parentSourceId,
          ...(original.capturedRect ? { capturedRect: original.capturedRect } : { capturedRectUnavailable: true }) };
        const candidate = { ...capturedNeighborRects, [kind]: [...capturedNeighborRects[kind], rect] };
        if (JSON.stringify(candidate).length <= neighborBudget) capturedNeighborRects[kind].push(rect);
      }
    }
    if (neighbors.children.length || neighbors.siblings.length) {
      const geometry = { ...capturedNeighborRects,
        omittedChildren: neighbors.children.length - capturedNeighborRects.children.length,
        omittedSiblings: neighbors.siblings.length - capturedNeighborRects.siblings.length };
      if (!append('capturedNeighborRects', geometry, false)) omissions.push('capturedNeighborRects（预算不足）');
    }
    const ancestors = (Array.isArray(facts.ancestors) ? facts.ancestors : []) as Record<string, unknown>[];
    if (facts.target && typeof facts.target === 'object') {
      const targetLimit = Math.min(available(), Math.max(220, Math.floor(available() * (ancestors.length ? 0.45 : 1))));
      const target = compactFact(facts.target as Record<string, unknown>, targetLimit);
      if (!target || !append('target', target, false)) omissions.push('target（预算不足）');
    } else layout.targetUnavailable = true;
    // The reader supplies actual nearest-first ancestry. Divide the remaining
    // budget so one large ancestor cannot consume every later ancestor's slot.
    ancestors.forEach((original, index) => {
      const limit = Math.min(available(), Math.max(220, Math.floor(available() / (ancestors.length - index))));
      const node = compactFact(original, limit);
      if (!node || !append('ancestors', node, true)) omissions.push(`ancestor:${original.sourceId}`);
    });
    for (const kind of ['children', 'siblings', 'ancestorPeers']) {
      const value = facts[kind];
      const nodes = Array.isArray(value) ? value : [value];
      for (const originalNode of nodes) {
        if (!originalNode || typeof originalNode !== 'object') continue;
        const node = stripRepeatedNotes(originalNode) as Record<string, unknown>;
        const key = JSON.stringify(node);
        if (seenLayout.has(key) || !append(kind, node, Array.isArray(value))) {
          omissions.push(`${kind}:${node.sourceId ?? node.ancestorSourceId ?? 'unknown'}`); continue;
        }
        seenLayout.add(key);
      }
    }
  } else layout.unavailable = true;
  return [prefix, `${layoutHeading}${JSON.stringify(layout)}`,
    ...(omissions.length ? [clip(`[省略 ${omissions.length} 项重复或超预算布局：${omissions.join(', ')}；需要时定向检查]`, omissionLimit)] : [])
  ].join('\n');
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
    ...objectSchema(fields, ['mode']),
    // Shared field schemas belong above; branches only add conditional requirements.
    anyOf: [
      { type: 'object', properties: { mode: { enum: ['none', 'preserve-existing'] } }, required: ['mode'] },
      { type: 'object', properties: { mode: { enum: ['local-demo'] } }, required: ['mode', ...INTERACTION_BEHAVIOR_FIELDS] },
      { type: 'object', properties: { mode: { enum: ['update-local-demo'] }, changes: { type: 'string', minLength: 1 } }, required: ['mode', 'changes'] }
    ]
  };
}

function spatialScopeSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { ...objectSchema(properties, required), anyOf: [
    { type: 'object', properties: { scope: { enum: ['global'] } }, required },
    { type: 'object', properties: { scope: { enum: ['selected-context', 'explicit-container'] },
      containerSourceId: { type: 'string', minLength: 1 } }, required: [...required, 'containerSourceId'] }
  ] };
}


const clineSourceRules = [
  '你是静态网页源码编辑 Agent，只用本轮源码工具实现 UI 示意，不接真实接口或业务提交。',
  RESPONSE_LANGUAGE_INSTRUCTIONS,
  'originalInstruction 是用户原文，userInstructionHistory 是路由对话中的此前用户原文，instruction 是路由转述，不增加授权；只执行有用户依据的要求。原文为澄清回复时结合此前原任务和仍适用的约束；回答只补全未确定信息，不替换原任务。conversation 仅属当前会话，副本可能已被其他会话修改；以本轮源码与选区为状态证据，不重放历史修改或回滚他人成果。',
  'selectedSourceId 是本轮选区目标；selectionContextSourceId 仅提供当前选区的读取参考，不授权把其它目标改成选区或扩展修改范围。具体对象与参照关系由用户原文确定。',
  '按当前轮次交付：用户暂时只要求展示或输入时，仅实现该状态，不从控件名称推导校验、提交、反馈或下一阶段功能。平台支持某种交互不等于本轮要求它；既有交互按要求保留，后续明确提出的行为再实现。',
  '改写或扩充文案时保留原始事实、时态和确定性：操作要求不能改成已经完成的结果，不补造验证结论、业务数据或承诺。用户提供的目标文字优先准确采用；需要扩写时只解释已有含义，缺少的事实不猜测。',
  '先确认目标、最近相关容器和必要相邻元素；重大歧义先 clarify，已确认的约束不重新比较。输入已有文件摘要和 selectedElementContext，直接复用；无目标时 query_workspace_structure，再按需 inspect_elements。证据足够就声明意图并执行，不为比较未要求的方案扩展检索；选区明确时争取前两次决策内开始写入。',
  'inspect_elements 提供结构摘要、布局与样式线索，不能当作精确源码。缺信息才用 full 或按字符范围 read_file。样式用 query_style_symbols，已知目标优先 sourceId + properties 一次查齐，source 默认 all；未命中不要求补查，已有组件样式不重复搜索，大 CSS 不全文读取。',
  '发现决定方案的证据缺口时，先直接查询该证据，再形成一个满足约束的实施方案；不要在读取前反复推演假设分支。当前证据已支持方案时，不为可选美化或未要求的不变量追加规划和读写。',
  'index.html 保存结构文案；有 author.css 或 author-style-links.json 时视觉修改只写 author-overrides.css，否则写 snapshot.css。author.css、outline.json、source-map.json 只读。',
  '首次写入前 declare_intent 锁定目标、相关 sourceId、效果约束和范围。先确定实施机制即可，不在此轮预演完整代码；声明后直接实施，仅因工具新证据或实现与约束冲突调整方案，不放宽需求。新增 sourceId 自动加入验证范围。',
  '声明前对照用户原文核对目标、空间关系和保持要求，requestedRelations 记录用户要求，mechanism 记录实现手段，不把自己的方案写成需求。判断空间不足前检查实际相关容器和邻居矩形；缺少或省略的矩形不代表空间不足。方案必须保留原要求，需要改变要求时先 clarify，不能自行用另一种位置关系替代。',
  '修改已有本地交互时，先读取本轮 module.jsx，再用 interactionPlan.mode=update-local-demo 和 changes 简述本次行为变化；未涉及的行为以当前源码为准保留，不重新设计完整交互。新建交互用 local-demo 完整声明。任一模式涉及布局变化仍需 layoutPlan。',
  'visualConstraints 保留用户要求的参照对象、内外边界、视觉关系及保持区域；不得以源码前后顺序代替视觉位置。新增、移动、尺寸或排列变化需 layoutPlan，基于实际布局说明机制及保持方式；纯文案/颜色可省略。注意自动排布、定位与新增同级元素对邻居的影响。',
  '调整尺寸/排列时核对已有 box-sizing、padding、border、尺寸约束、伸缩规则、相关祖先 overflow；百分比内容宽度不等于外部总宽度，内层高度不能消除外层裁切。缺关键属性则一次定向查询；按证据修改，不统一 height:auto 或解除 overflow；简单改字不增加布局检查。背景可能在子元素/伪元素，注意级联优先级。',
  '位置以用户明确容器为准，否则以 selectedSourceId 或最近语义祖先为锚点；相邻组件范围仅扩至最近公共父容器。普通页面内容未获全局视口定位授权时禁止新增 position:fixed；局部弹层可用组件公开浮层能力或依实际触发元素测量定位，但必须随锚点变化更新，不能把模块本体改为全局悬浮。新增节点后必须 validate_spatial_scope。',
  INTERACTION_INSTRUCTIONS,
  '纯文案优先 set_element_text，须定位真实文字承载元素，不能清空含图标或其他子结构的父控件。完整元素替换用 replace_element；内部精确替换用 replace_in_element，search 必须来自已读原文，不从 compactHtml/domText/摘要拼接。文件级替换也基于原文，追加 CSS 用 apply_patch。',
  '属性、插入、移动、删除使用结构化工具。参数已知且不依赖前一工具结果的相关操作在同一轮提交，运行时依次执行；批量 DOM 用 apply_dom_operations。依赖新生成 sourceId 或失败反馈时等待结果，不猜测标识。',
  '工具返回成功即已完成该次写入，继续使用返回的 sourceId，不因仍在讨论实现而重放成功操作。只有用户确实要求再次创建时才重复新增；不确定当前状态先定向读取。精确替换的 search 与 replace 必须有实际差异，满足需求后不再添加可选功能或纯防御性外观改动。',
  '普通 HTML 禁止 script、事件属性、远程资源、接口请求、表单 action、javascript: URL。',
  '修改后复用现有源码和工具结果逐项核对约束。已声明布局方案则 review_layout_plan：先核对方案忠于原始需求，再核对实际操作；有遗漏先修正，后续修改需重新核对。新增节点先校验空间归属，最后 finish 校验并提交；无需修改须有当前源码证据并用 already_satisfied。',
  '源码与捕获布局不证明修改后渲染效果，不能声称位置、可见性、裁切、邻居布局或浏览器验证已通过。已知未完成项或风险必须说明，不能为简短隐瞒。',
  '进展说明是用户可见的正文，工具调用前后的每一段说明也必须遵守回复语言要求，默认使用简体中文，不能只有 finish.summary 使用中文。与工具调用同轮输出：开始一句，取得新证据/进入修改/遇到问题时再简述；没有新进展直接调用工具。不逐工具播报、不输出推理、sourceId或技术日志、不提前声称成功。不要为说明单独结束一轮。',
  'finish.summary 面向用户，通常两句：概括修改，必要时补操作方法或真实限制。只陈述源码已落实的行为，不把计划或推测的组件默认行为写成已完成事实。不复述完整需求和文案，不写文件/class/框架/工具或校验日志。仅有待确认的具体布局效果时简短提醒；简单改字不附通用免责声明。未调用 finish 或 clarify 不算完成，不做无关重构。'
].join('\n');

const DEFAULT_MAX_ITERATIONS = 45;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MAX_BATCH_INSPECTION_CHARS = 12_000;
const MAX_BATCH_ELEMENT_CHARS = 4_000;
const FINALIZATION_WINDOW = 3;
const MAX_IDENTICAL_TOOL_FAILURES = 3;
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
  enableThinking?: boolean;
  reasoningProvider?: 'deepseek' | 'qwen';
  reasoningEffort?: 'none' | 'low' | 'high' | 'max';
  resolveReasoningEffort?: () => 'none' | 'low' | 'high' | 'max';
  resolveMaxOutputTokens?: (context: { reasoningEffort?: 'none' | 'low' | 'high' | 'max'; recoveringOutputLimit: boolean }) => number;
  apiProtocol?: 'chat-completions';
  systemPrompt: string;
  tools: readonly AgentTool<any, any>[];
  maxIterations: number;
  maxOutputTokens: number;
}

export type ClineAgentFactory = (input: ClineAgentFactoryInput) => ClineAgentInstance;

export interface ClineCodingAgentOptions {
  skills?: SkillProvider;
  baseUrl: string;
  enableThinking?: boolean;
  reasoningProvider?: 'deepseek' | 'qwen';
  reasoningEffort?: 'none' | 'low' | 'high' | 'max';
  editReasoning?: import('../core/coding-agent-port').EditReasoning;
  apiProtocol?: 'chat-completions';
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
      enableThinking: input.enableThinking,
      reasoningProvider: input.reasoningProvider,
      reasoningEffort: input.reasoningEffort,
      resolveReasoningEffort: input.resolveReasoningEffort,
      resolveMaxOutputTokens: input.resolveMaxOutputTokens,
      apiProtocol: input.apiProtocol,
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
    const policy = editModePolicy(turn.request.editMode, this.options.editReasoning);
    const editReasoning = policy.reasoning;
    const modeRules = `${clineSourceRules}\n${policy.instructions}`;
    const startedAt = new Date().toISOString();
    const selectionContextSourceId = turn.request.sourceId ?? turn.request.selectionContextSourceId;
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
    let declaredInteractionMode = 'none';
    const sourceReviews: SourceReviewResult[] = [];
    let sourceReviewNeedsCorrection = false;
    let sourceReviewFailedVersion = -1;
    let sourceToolNeedsCorrection = false;
    let independentlyReviewedVersion = -1;
    let primaryModelCalls = 0;
    const localizer = createCommentaryLocalizer(this.factory, {
      providerId: 'openai-compatible', modelId: this.options.modelName, apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl, apiProtocol: this.options.apiProtocol, reasoningProvider: this.options.reasoningProvider
    }, turn.request.originalInstruction ?? turn.request.instruction,
    entry => safeEmit(observe, { type: 'coding-agent.commentary', ...entry }), signal);
    const totalModelCalls = () => primaryModelCalls + sourceReviews.reduce((sum, item) => sum + item.modelCalls, 0)
      + localizer.report.modelCalls;
    let layoutPlan: { containerSourceIds: string[]; requestedRelations: string; mechanism: string; preservedRegions: string } | undefined;
    let mutationVersion = 0;
    let reviewedLayoutVersion = -1;
    const layoutChanges: { action: string; input: unknown; operationId: string; toolCallId?: string }[] = [];
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
      editMode: policy.mode,
      editPolicy: { revision: policy.revision, reasoning: editReasoning, preMutationReads: policy.preMutationReads, readLimits: policy.readLimits,
        sourceReviewEnabled: policy.sourceReviewEnabled, reviewEffort: policy.reviewEffort, maxReviews: policy.maxReviews },
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
      primaryModelCalls = Math.max(primaryModelCalls, context.iteration);
      if (outcome === 'blocked') context.emitUpdate?.({ type: 'tool-outcome', outcome });
      checkpoint = {
        ...checkpoint,
        modelCalls: totalModelCalls(),
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
      if (!turn.request.sourceId || !selectedElementContextAvailable || firstMutationAt) return '';
      const remaining = Math.max(0, policy.preMutationReads - preMutationReadCalls);
      return `[修改前读取额度] 已提供选区上下文；补充读取已用 ${preMutationReadCalls}/${policy.preMutationReads} 次，剩余 ${remaining} 次（按工具调用计数，同轮多次调用分别计数）。${remaining === 0
        ? '下一步不要再请求读取；证据足够则声明意图并修改，缺少会显著影响结果的信息则 clarify，不猜测布局。'
        : '仅为明确缺失的证据读取，不必用满额度；证据足够则声明意图并修改。'} 各读取工具另有上限：${JSON.stringify(policy.readLimits)}。`;
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
      const actionLimit = policy.readLimits[action];
      if (BUDGETED_READ_ACTIONS.has(action) && turn.request.sourceId && selectedElementContextAvailable && !firstMutationAt
        && preMutationReadCalls >= policy.preMutationReads) {
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
          sourceToolNeedsCorrection = false;
          mutationVersion += 1;
          layoutChanges.push({ action, input, operationId: `mutation-${mutationVersion}`, toolCallId: context.toolCallId });
          if (!firstMutationAt) {
            firstMutationAt = new Date().toISOString();
            firstMutationModelCall = context.iteration;
          }
          completedReadResults.clear();
          readActionCounts.clear();
          repeatedFailures.clear();
          // Module implementation cannot alter the authored HTML ancestry or
          // its CSS positioning permissions. Its layout still needs a fresh
          // review; retain only the already checked source-container fact.
          if (newSourceIds.size > 0 && !(action === 'apply_patch'
            && (input as { path?: string }).path === 'module.jsx')) spatialScopeValidated = false;
        }
        if (readKey) completedReadResults.set(readKey, result);
        throwIfCancelled();
        const pending = MUTATING_ACTIONS.has(action) ? pendingCompletionRequirements() : [];
        const resultWithRequirements = pending.length
          ? `${result}\n[提交前条件] ${pending.join('；')}` : result;
        const finalizationResult = remainingAfterThisCall <= 5
          ? `[运行预算] 当前第 ${context.iteration}/${this.maxIterations} 轮，本次后最多剩余 ${remainingAfterThisCall} 轮。请停止扩展范围，完成必要修改并预留 finish。\n\n${resultWithRequirements}`
          : resultWithRequirements;
        const guidance = BUDGETED_READ_ACTIONS.has(action) ? readBudgetGuidance() : '';
        const guidedResult = guidance ? `${guidance}\n\n${finalizationResult}` : finalizationResult;
        record(action, input, context, guidedResult);
        return guidedResult;
      } catch (error) {
        if (MUTATING_ACTIONS.has(action)) sourceToolNeedsCorrection = true;
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

    // Report all known prerequisites together so fixing one does not reveal
    // another on the next completion attempt. Execution still checks fresh state.
    const pendingCompletionRequirements = (): string[] => {
      const pending: string[] = [];
      if (introducedFixedPosition && declaredIntent?.layoutScope !== 'global') {
        pending.push('当前已确认意图不是 global 布局范围，本轮却新增了 position:fixed；请调整到已确认容器内');
      }
      if (newSourceIds.size > 0 && !spatialScopeValidated) {
        pending.push(`本轮新增了 ${newSourceIds.size} 个源码元素，finish 前必须调用 validate_spatial_scope 校验其参照容器`);
      }
      if (layoutPlan && reviewedLayoutVersion !== mutationVersion) {
        pending.push('调用 review_layout_plan 核对最新源码操作；若继续修改，需重新核对');
      }
      return pending;
    };

    const tools: AgentTool<any, any>[] = [
      createTool<{
        summary: string;
        interactionPlan: {
          mode: 'none' | 'preserve-existing' | 'local-demo' | 'update-local-demo';
          changes?: string;
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
        layoutPlan?: { containerSourceIds: string[]; requestedRelations: string; mechanism: string; preservedRegions: string };
        layoutScope?: 'selected-context' | 'explicit-container' | 'global';
      }, string>({
        name: 'declare_intent',
        description: '首次写入前声明目标、范围和约束。none/preserve-existing 仅需 mode；新建交互 local-demo 填完整交互；已有本地交互 update-local-demo 只填 changes。只确定实施决策，不展开代码设计；有关键歧义用 clarify。',
        inputSchema: objectSchema({
          summary: stringProperty('面向用户最多两句：准备改什么、必要时保留什么；不写内部推理、源码标识或完成结论。'),
          interactionPlan: interactionPlanSchema({
            mode: {
              type: 'string',
              enum: ['none', 'preserve-existing', 'local-demo', 'update-local-demo'],
              description: '无交互改动、保留既有交互、新建本地演示交互，或修改已读取源码的本地交互。真实业务行为不在副本能力内，应 clarify。'
            },
            changes: stringProperty('update-local-demo 必填：仅描述本次用户要求改变的行为；其余已有行为保持，不复述整套状态与实现。需先 read_file 读取本轮 module.jsx。'),
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
            type: 'array', minItems: 1, maxItems: 12,
            items: stringProperty('与本次目标相关的 sourceId。')
          },
          verificationSourceIds: {
            type: 'array', maxItems: 16,
            items: stringProperty('真实浏览器需要测量的已有 sourceId。')
          },
          visualConstraints: {
            type: 'array', maxItems: 12,
            items: stringProperty('用户要求的效果、参照对象、视觉关系和保持区域；DOM 顺序不代替视觉关系。')
          },
          layoutPlan: objectSchema({
            containerSourceIds: { type: 'array', minItems: 1, maxItems: 12, items: stringProperty('实际控制目标布局的已有容器 sourceId。') },
            requestedRelations: stringProperty('忠实记录用户要求的位置关系：对象、参照对象、方向和内外边界。与下方实施机制分开；不能把视觉方向改写成源码先后、相邻位置或默认排布。没有指定方向时保留原有关系，不新增要求。'),
            mechanism: stringProperty('基于已读布局，简述结构/样式机制如何实现目标关系；已有布局足够可说明理由，不强改 CSS。并排需核对可用宽度、占用、换行/收缩；源码前后或换行不等于左右。空间不足时选满足约束的方案，须改变需求则 clarify。'),
            preservedRegions: stringProperty('列出用户明确要求保持的区域及具体属性，并说明保护方式；其余区域避免无关修改。不把保持位置或宽度扩展为冻结全部尺寸，也不为正常文档流变化增设固定尺寸。无保持要求时说明。')
          }, ['containerSourceIds', 'requestedRelations', 'mechanism', 'preservedRegions']),
          layoutScope: { type: 'string', enum: ['selected-context', 'explicit-container', 'global'] }
        }, ['summary', 'interactionPlan', 'relevantSourceIds']),
        execute: (input, context) => execute(
          'declare_intent',
          input,
          context,
          async () => {
            const interactionPlan = input.interactionPlan;
            if (interactionPlan.mode === 'update-local-demo') {
              const hasCurrentModuleRead = [...completedReadResults.keys()].some(key =>
                key.startsWith('read_file:') && JSON.parse(key.slice('read_file:'.length)).path === 'module.jsx');
              if (!hasCurrentModuleRead) {
                throw new Error('update-local-demo 需要先 read_file 读取本轮 module.jsx；历史对话不能代替当前源码');
              }
            }
            const sourceIds = [...new Set([
              ...(turn.request.sourceId ? [turn.request.sourceId] : []),
              ...(input.relevantSourceIds ?? []),
              ...(input.verificationSourceIds ?? [])
            ])];
            const interactionConstraint = interactionPlan.mode === 'none'
              ? undefined
              : interactionPlan.mode === 'preserve-existing'
                ? '保留既有交互；本轮只执行声明的修改目标和约束'
                : interactionPlan.mode === 'update-local-demo'
                  ? `已有本地交互的本次变化：${interactionPlan.changes}；未涉及的行为保留本轮已读取源码的实现，不追加未授权功能`
                : `交互方案：初始=${interactionPlan.initialState}；触发=${interactionPlan.trigger}；结果=${interactionPlan.result}；布局=${interactionPlan.layoutBehavior}；结束=${interactionPlan.completionBehavior}；节点=${interactionPlan.nodeIdentity}`;
            const constraints = [...new Set([
              ...(input.visualConstraints?.length ? input.visualConstraints : [input.summary]),
              ...(interactionConstraint ? [interactionConstraint] : [])
            ])];
            if (!sourceIds.length) {
              throw new Error('declare_intent 必须列出至少一个实际相关的 sourceId；请先查询并检查目标结构，无法定位时调用 clarify');
            }
            if (input.layoutPlan && (!input.layoutPlan.containerSourceIds?.length
              || !input.layoutPlan.requestedRelations?.trim()
              || !input.layoutPlan.mechanism?.trim() || !input.layoutPlan.preservedRegions?.trim())) {
              throw new Error('布局方案需包含用户要求的位置关系、实际容器、实施机制及保持区域的处理方式');
            }
            if (layoutPlan && !input.layoutPlan) {
              throw new Error('已声明布局方案，不能通过重新声明省略方案来跳过核对');
            }
            layoutPlan = input.layoutPlan;
            declaredInteractionMode = input.interactionPlan.mode;
            independentlyReviewedVersion = -1;
            reviewedLayoutVersion = -1;
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
            return `意图已记录：${sourceIds.length} 个目标，${constraints.length} 项效果约束，交互=${interactionPlan.mode}。按本次声明直接执行；约束原文见本次调用参数，尚未验证渲染结果。`;
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
            selectedSourceId: input.selectedSourceId ?? turn.request.sourceId
              ?? (selectedElementContextAvailable ? turn.request.selectionContextSourceId : undefined),
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
            const separator = '\n\n---\n\n';
            const budget = Math.min(ids.length === 1 ? MAX_BATCH_INSPECTION_CHARS : MAX_BATCH_ELEMENT_CHARS,
              Math.floor((MAX_BATCH_INSPECTION_CHARS - separator.length * (ids.length - 1)) / ids.length));
            const seenLayout = new Set<string>();
            const results = await Promise.all(ids.map(sourceId =>
              workspace.inspectElement(sourceId, { detail: input.detail ?? 'compact' })));
            const sections = results.map(result => boundedInspection(result, budget, seenLayout));
            return sections.join(separator);
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
        description: '结构化设置或删除元素属性；不接受 style、sourceId 或捕获矩形。样式使用可编辑 CSS 或基于已读原文的 replace_in_element；移动已有节点使用 move_element。',
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
        description: '按源码树顺序在目标元素内部开头/末尾或目标前后插入静态 HTML；这些位置不代表屏幕上下左右。系统为所有新元素生成 sourceId。可选提供已检查的同类元素作为冻结计算样式参照。',
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
        description: '按 sourceId 原样移动元素，所有位置均相对于必填的 targetSourceId。insideStart/insideEnd 放入目标容器内部；before/after 仅表示源码同级顺序，不保证视觉方向，也不保证其他元素原位不变。',
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
        description: '克隆元素并生成新 sourceId。所有位置相对于必填 targetSourceId：insideStart/insideEnd 为目标内部，before/after 为源码中的同级前后，replace 替换目标。源码顺序不保证视觉方向；网格、弹性及定位布局需根据实际样式规划，避免挤走原有区域。',
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
        description: '仅校验新增节点的源码容器归属及定位权限，不检查浏览器坐标、视觉方向、裁切或相邻区域是否移动。新增元素后、finish 前必须调用，通过不代表视觉要求已满足。',
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
            return `源码容器归属校验通过（未验证视觉位置、裁切及邻居位移）：scope=${input.scope}${input.containerSourceId ? `，container=${input.containerSourceId}` : ''}${removedSourceIds.length ? `；已忽略本轮随后删除的元素 ${removedSourceIds.join(', ')}` : ''}；${input.reason}`;
          }
        )
      }),
      createTool<Record<string, never>, string>({
        name: 'review_layout_plan',
        description: '布局修改后返回原始请求、方案、当前容器与成功操作引用。核对需求和实际实现；操作记录不是最终 diff，缺证据或操作覆盖时读当前源码。后续修改需再核对，不判断视觉结果。',
        inputSchema: objectSchema({}, []),
        execute: (input, context) => execute('review_layout_plan', input, context, async () => {
          if (!layoutPlan) throw new Error('尚未声明 layoutPlan');
          const containerIds = [...new Set(layoutPlan.containerSourceIds)];
          const budget = Math.min(MAX_BATCH_ELEMENT_CHARS, Math.floor(MAX_BATCH_INSPECTION_CHARS / containerIds.length));
          const currentContainers = [];
          for (const sourceId of containerIds) {
            const source = await workspace.inspectElement(sourceId, { detail: 'compact' });
            currentContainers.push({ sourceId, context: boundedInspection(source, budget, new Set<string>()) });
          }
          reviewedLayoutVersion = mutationVersion;
          return JSON.stringify({
            evidence: '先核对方案是否保留原始请求的参照对象、内外边界、位置关系，再核对实际实现；缺项先修正。以下不是浏览器渲染证据。',
            originalRequest: turn.request.originalInstruction ?? turn.request.instruction,
            ...(turn.request.userInstructionHistory?.length ? { userInstructionHistory: turn.request.userInstructionHistory } : {}),
            ...(turn.request.originalInstruction && turn.request.originalInstruction !== turn.request.instruction
              ? { routedInstruction: turn.request.instruction } : {}),
            currentContainers,
            contextEvidence: '容器结构来自当前工作区，矩形/计算样式仍是捕获值。按当前子项与布局规则核对受影响区域；邻居源码未改不等于位置未变。',
            layoutPlan,
            constraints: declaredIntent?.constraints,
            mutationVersion,
            changeEvidence: '以下为成功操作的参数摘要，长字符串省略；完整参数在对应历史工具调用中，哈希仅用于追溯，不能证明正确性。操作可能相互覆盖，不等于当前最终源码。',
            changes: layoutChanges.map(change => summarizeLayoutChange(change)),
            next: '结合当前容器与历史操作原文核对；缺少代码细节、操作相互覆盖或无法确定最终状态时定向读取当前源码。finish.layoutAssessment 说明结构/样式如何落实用户要求与保持区域。'
          });
        })
      }),
      createTool<{
        summary: string;
        outcome?: 'changed' | 'already_satisfied';
        evidence?: string;
        layoutAssessment?: string;
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
          layoutAssessment: stringProperty('有 layoutPlan 时必填：以核对结果说明原始目标关系、实际实现和保持约束；缺项先修正，不能用意图代替实现证据或声称渲染验证。'),
          evidence: stringProperty('仅 outcome=already_satisfied 时填写：说明已读取和验证的当前源码证据。')
        }, ['summary']),
        resolveInputSchema: base => {
          const pending = pendingCompletionRequirements();
          return {
            ...base,
            ...(layoutPlan ? { required: ['summary', 'layoutAssessment'] } : {}),
            ...(pending.length ? { description: `提交前待完成：${pending.join('；')}。这些条件按执行时状态重新检查。` } : {})
          };
        },
        lifecycle: { completesRun: true },
        execute: async (input, context) => {
          try {
            throwIfCancelled();
            if (clarificationRequested || completion?.kind === 'clarification') {
              throw new Error('本轮已进入等待用户澄清状态，禁止提交；请等待用户回复后开启新一轮执行');
            }
            requireIntentDeclared();
            const pending = pendingCompletionRequirements();
            if (layoutPlan && !input.layoutAssessment?.trim()) {
              pending.push('在 finish.layoutAssessment 中说明实际实现与方案的对应关系');
            }
            if (pending.length) throw new Error(`提交前仍需完成：${pending.join('；')}`);
            const validation = await workspace.validate();
            if (policy.sourceReviewEnabled && firstMutationAt
              && (layoutPlan || ['local-demo', 'update-local-demo'].includes(declaredInteractionMode)
                || layoutChanges.some(change => (change.input as { path?: string }).path === 'module.jsx'))
              && independentlyReviewedVersion !== mutationVersion) {
              if (sourceReviews.length >= policy.maxReviews) throw Object.assign(new Error('本轮源码核对预算已用完，尚未获得可提交实现，已停止本轮修改。'), { terminalToolError: true });
              const containerIds = [...new Set(layoutPlan?.containerSourceIds ?? (turn.request.sourceId ? [turn.request.sourceId] : []))];
              const containers = await Promise.all(containerIds.map(async sourceId => ({ sourceId,
                context: boundedInspection(await workspace.inspectElement(sourceId, { detail: 'compact' }),
                  Math.floor(6000 / containerIds.length), new Set<string>()),
                ...(workspace.readElementSource ? { currentHtml: await workspace.readElementSource(sourceId) } : {}) })));
              const currentFiles = await workspace.listFiles();
              const sources = await Promise.all(currentFiles.filter(file => file.path === 'module.jsx' || file.path.endsWith('overrides.css'))
                .map(async file => {
                  // readFile defaults to 120 lines. Explicit character ranges
                  // prevent a partial module from being labelled complete.
                  if (!file.chars) return { path: file.path, complete: true, source: '' };
                  if (file.chars <= 20000) return { path: file.path, complete: true,
                    source: await workspace.readFile(file.path, undefined, undefined, 0, file.chars) };
                  return { path: file.path, complete: false, omittedChars: file.chars - 20000,
                    sourceStart: await workspace.readFile(file.path, undefined, undefined, 0, 10000),
                    sourceEnd: await workspace.readFile(file.path, undefined, undefined, file.chars - 10000, file.chars) };
                }));
              const review = await reviewSourceImplementation(this.factory, { providerId: 'openai-compatible',
                modelId: this.options.modelName, apiKey: this.options.apiKey, baseUrl: this.options.baseUrl,
                enableThinking: this.options.enableThinking, reasoningProvider: this.options.reasoningProvider, apiProtocol: this.options.apiProtocol }, {
                  originalRequest: turn.request.originalInstruction ?? turn.request.instruction,
                  ...(turn.request.userInstructionHistory?.length ? { userInstructionHistory: turn.request.userInstructionHistory } : {}),
                  conversation: turn.conversation.slice(-8),
                  selectedSourceId: turn.request.sourceId, containers, sources,
                  evidence: '结构与源码来自当前工作区；计算样式与矩形是捕获值，不是当前渲染。省略项不能视为不存在。'
                }, signal, policy.reviewEffort, policy.reviewOutputTokens);
              sourceReviews.push(review);
              checkpoint = { ...checkpoint, sourceReviews: [...sourceReviews] };
              throwIfCancelled();
              sourceReviewNeedsCorrection = !review.accepted;
              if (!review.accepted) sourceReviewFailedVersion = mutationVersion;
              if (!review.accepted) throw new Error(`提交已阻止：${review.feedback}。修正当前源码后重新完成核对与 finish，不改变用户要求。`);
              independentlyReviewedVersion = mutationVersion;
            }
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

    // Match existing execution guards before the next model decision. Exposing
    // an exhausted read tool only invites a paid call that cannot execute.
    // Per-file budgets stay in execute(): another file may still be readable.
    // Mutation resets the counters, so these tools automatically return.
    for (const tool of tools) {
      if (MUTATING_ACTIONS.has(tool.name)) {
        tool.isAvailable = () => intentDeclared && !clarificationRequested;
        continue;
      }
      if (tool.name === 'finish') {
        tool.isAvailable = () => intentDeclared && !clarificationRequested && pendingCompletionRequirements().length === 0;
        continue;
      }
      if (tool.name === 'review_layout_plan') {
        tool.isAvailable = () => Boolean(layoutPlan);
        continue;
      }
      if (tool.name === 'validate_spatial_scope') {
        tool.isAvailable = () => intentDeclared && newSourceIds.size > 0;
        continue;
      }
      if (!BUDGETED_READ_ACTIONS.has(tool.name)) continue;
      tool.isAvailable = ({ iteration }) => {
        if (tool.name !== 'inspect_elements'
          && iteration >= Math.max(1, this.maxIterations - FINALIZATION_WINDOW + 1)) return false;
        if (turn.request.sourceId && selectedElementContextAvailable && !firstMutationAt
          && preMutationReadCalls >= policy.preMutationReads) return false;
        if (tool.name === 'read_file' || tool.name === 'search_text') return true;
        const limit = policy.readLimits[tool.name];
        return !limit || (readActionCounts.get(tool.name) ?? 0) < limit;
      };
    }

    let response: SourceTurnResponse;
    let unsubscribe: (() => void) | undefined;
    let flushCommentary = () => {};
    try {
      throwIfCancelled();
      const skill = this.options.skills?.open(turn.request.skillId, turn.request.skillVersion, turn.request.disabledSkillIds);
      if (skill) tools.push(...skillTools(skill, record));
      const files = await workspace.listFiles();
      let selectedElementContext: string | undefined;
      if (selectionContextSourceId) {
        try {
          selectedElementContext = await workspace.inspectElement(selectionContextSourceId, { detail: 'compact' });
          if (turn.request.sourceId) originalSelectedPath = ancestrySourceIds(selectedElementContext);
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
        enableThinking: this.options.enableThinking,
        reasoningProvider: this.options.reasoningProvider,
        reasoningEffort: this.options.reasoningEffort,
        ...(editReasoning ? { resolveReasoningEffort: () => (
          // Spend correction reasoning on the first repair. A successful source
          // mutation returns to the post-write policy; a rejected re-review
          // re-arms correction for that new source version.
          (sourceReviewNeedsCorrection && sourceReviewFailedVersion === mutationVersion)
          || sourceToolNeedsCorrection) && editReasoning.correction
          ? editReasoning.correction : intentDeclared
          ? firstMutationAt ? editReasoning.verification ?? editReasoning.execution
            : layoutPlan && ['none', 'preserve-existing'].includes(declaredInteractionMode)
              ? editReasoning.layoutExecution ?? editReasoning.execution
              : editReasoning.execution
          : preMutationReadCalls > 0 ? editReasoning.planning : editReasoning.discovery } : {}),
        ...(editReasoning ? { resolveMaxOutputTokens: ({ reasoningEffort, recoveringOutputLimit }) =>
          // Reading and declaring intent do not generate implementation code.
          // Keep full room for actual thinking and for an oversized declaration
          // recovered by the existing bounded output-limit protocol.
          !intentDeclared && reasoningEffort === 'none' && !recoveringOutputLimit
            ? Math.min(2048, this.maxOutputTokens) : this.maxOutputTokens } : {}),
        apiProtocol: this.options.apiProtocol,
        systemPrompt: `${modeRules}\n${skill?.prompt ?? ''}\n${RESPONSE_LANGUAGE_INSTRUCTIONS}\n单轮最多 ${this.maxIterations} 次模型决策；从第 ${Math.max(1, this.maxIterations - FINALIZATION_WINDOW + 1)} 轮起必须停止扩展读取，只能完成必要修改并 finish，或 clarify。`,
        tools,
        maxIterations: this.maxIterations,
        maxOutputTokens: this.maxOutputTokens
      });
      let commentaryCall = 0;
      let commentaryText = '';
      let publishedCommentary = '';
      let commentaryTimestamp = '';
      const queuedCommentary = new Set<number>();
      const publishCommentary = (final = false) => {
        const text = commentaryText.trim().slice(0, 600);
        if (!text || text === publishedCommentary || commentaryCall < 1 || queuedCommentary.has(commentaryCall)) return;
        const entry = { timestamp: commentaryTimestamp, modelCall: commentaryCall, text };
        if (needsCommentaryLocalization(text)) {
          if (final) { queuedCommentary.add(commentaryCall); localizer.enqueue(entry); }
          return;
        }
        // Wait for enough text to distinguish Chinese from an English prefix.
        if (!final && !/\p{Script=Han}/u.test(text)) return;
        publishedCommentary = text;
        safeEmit(observe, { type: 'coding-agent.commentary', ...entry });
      };
      flushCommentary = () => publishCommentary(true);
      unsubscribe = activeAgent.subscribe?.(event => {
        const timestamp = new Date().toISOString();
        // Only explicit assistant text is public commentary. Never consume
        // reasoning deltas or accumulatedText (which spans multiple rounds).
        if (event.type === 'assistant-text-delta' && typeof event.text === 'string') {
          const iteration = Number(event.iteration);
          if (!Number.isInteger(iteration) || iteration < 1) return;
          if (commentaryCall !== iteration) {
            publishCommentary(true);
            commentaryTimestamp = timestamp;
            commentaryCall = iteration;
            commentaryText = '';
            publishedCommentary = '';
          }
          commentaryText = (commentaryText + event.text).slice(0, 600);
          publishCommentary();
        }
        if (event.type === 'model-call-updated' && 'call' in event) {
          const call = modelCallProgressSchema.safeParse(event.call);
          if (call.success) primaryModelCalls = Math.max(primaryModelCalls, call.data.modelCall);
          if (call.success && call.data.status === 'completed') publishCommentary(true);
          if (call.success) safeEmit(observe, { type: 'coding-agent.model.updated', timestamp, call: call.data });
        }
        if (event.type === 'tool-started' && 'toolCall' in event) {
          publishCommentary(true);
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
        ...(turn.request.userInstructionHistory?.length ? { userInstructionHistory: turn.request.userInstructionHistory } : {}),
        readBudget: readBudgetGuidance(),
        selectedSourceId: turn.request.sourceId,
        selectionContextSourceId: turn.request.selectionContextSourceId,
        replyToClarificationId: turn.request.replyToClarificationId,
        clarificationOptionId: turn.request.clarificationOptionId,
        conversation: turn.conversation.slice(-8),
        files,
        workspaceMode: files.some(file => file.path === 'author.css' || file.path === 'author-style-links.json')
          ? 'author-rules'
          : 'frozen-styles',
        selectedElementContext
      }));
      primaryModelCalls = Math.max(primaryModelCalls, result.iterations);
      checkpoint = {
        ...checkpoint,
        modelCalls: totalModelCalls(),
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
    flushCommentary();
    await localizer.finish();
    if (response.kind === 'completed') response = { ...response, modelCalls: totalModelCalls() };
    signal?.removeEventListener('abort', abortActiveAgent);
    activeAgent = undefined;

    const timestamp = new Date().toISOString();
    checkpoint = {
      ...checkpoint,
      modelCalls: totalModelCalls(),
      commentaryLocalization: localizer.report,
      lifecycle: {
        submissionMode: 'direct', intentDeclared, spatialScopeValidated,
        completionAttempts: steps.filter(step => step.action === 'finish').length,
        rollback: rollbackStatus,
        selectedElementContextProvided: selectedElementContextAvailable,
        selectionContextMode: selectedElementContextAvailable
          ? turn.request.sourceId ? 'target' : 'reference' : 'unavailable',
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
