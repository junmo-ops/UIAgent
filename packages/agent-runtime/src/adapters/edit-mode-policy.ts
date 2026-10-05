import type { EditMode } from '@ui-agent/contracts';

import type { EditReasoning } from '../core/coding-agent-port';

// Per-turn budgets: no shared adapter state is changed when a user switches mode.
export function editModePolicy(mode: EditMode = 'fast', fastReasoning?: EditReasoning) {
  const multiplier = mode === 'fast' ? 1 : mode === 'normal' ? 2 : 3;
  const reasoning: EditReasoning = mode === 'fast'
    ? fastReasoning ?? { discovery: 'none', planning: 'none', execution: 'none', verification: 'none', correction: 'low', layoutExecution: 'low' }
    : mode === 'normal'
      ? { discovery: 'none', planning: 'low', execution: 'low', verification: 'none', correction: 'low', layoutExecution: 'low' }
      : { discovery: 'none', planning: 'high', execution: 'high', verification: 'low', correction: 'high', layoutExecution: 'high' };
  return {
    revision: '2026-10-05-selective-reasoning-v2',
    mode, reasoning, preMutationReads: 4 * multiplier,
    readLimits: { query_workspace_structure: 2 * multiplier, search_text: 4 * multiplier,
      inspect_elements: 3 * multiplier, query_style_symbols: 3 * multiplier, read_file: 3 * multiplier } as Readonly<Record<string, number>>,
    sourceReviewEnabled: mode !== 'fast',
    reviewEffort: 'low' as const,
    reviewOutputTokens: mode === 'pro' ? 8192 : 4096,
    maxReviews: mode === 'fast' ? 0 : mode === 'pro' ? 4 : 3,
    instructions: mode === 'fast'
      ? '本轮为 Fast：速度优先，依据充分证据尽快完成明确要求，避免可选打磨；不得遗漏用户要求或跳过安全校验。'
      : mode === 'normal'
        ? '本轮为 Normal：兼顾速度与完成质量。先明确关键约束与实现方案，再修改；缺少关键上下文时定向补充，核对内容、布局机制和交互路径。'
        : '本轮为 Pro：优先完成质量。实施前综合原始需求、保持区域、页面风格和布局上下文形成完整方案；仔细处理交互状态、边界与视觉一致性，发现问题后定向修正。不得擅自扩展需求。',
  };
}
