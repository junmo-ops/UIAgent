import { z } from 'zod';

export const requirementReviewSchema = z.object({
  originalRequestReviewed: z.literal(true),
  missingRequirements: z.array(z.string()),
  checks: z.array(z.object({
    constraintIndex: z.number().int().positive(),
    status: z.enum(['implemented', 'unsupported', 'incomplete']),
    evidence: z.string().trim().min(1)
  })).min(1)
});
export type RequirementReview = z.infer<typeof requirementReviewSchema>;

export function validateRequirementReview(value: unknown, constraintCount: number): void {
  const parsed = requirementReviewSchema.safeParse(value);
  if (!parsed.success) throw new Error('提交前必须填写 requirementReview：重新核对原始需求、逐项实现证据及遗漏需求');
  const review = parsed.data;
  const indexes = new Set(review.checks.map(check => check.constraintIndex));
  if (indexes.size !== constraintCount || review.checks.length !== constraintCount ||
    review.checks.some(check => check.constraintIndex > constraintCount)) {
    throw new Error('需求复核必须覆盖全部已声明约束，每个 constraintIndex 恰好一次');
  }
  if (review.missingRequirements.length || review.checks.some(check => check.status !== 'implemented')) {
    throw new Error('需求尚未完整实现，禁止提交：请完成缺项；受能力限制时调用 clarify 与用户确认范围');
  }
}
