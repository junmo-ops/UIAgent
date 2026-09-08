import { describe, expect, it } from 'vitest';
import { validateRequirementReview } from './requirement-review';

describe('requirement review', () => {
  const review = { originalRequestReviewed: true, missingRequirements: [], checks: [
    { constraintIndex: 1, status: 'implemented', evidence: 'trigger targets panel' },
    { constraintIndex: 2, status: 'implemented', evidence: 'trigger dismiss outside' }
  ] };
  it('requires every constraint exactly once and no omitted original requirement', () => {
    expect(() => validateRequirementReview(review, 2)).not.toThrow();
    expect(() => validateRequirementReview(undefined, 2)).toThrow('提交前');
    expect(() => validateRequirementReview({ ...review, checks: [review.checks[0]] }, 2)).toThrow('全部');
    expect(() => validateRequirementReview({ ...review, checks: [review.checks[0], review.checks[0]] }, 2)).toThrow('全部');
    expect(() => validateRequirementReview({ ...review, missingRequirements: ['close outside'] }, 2)).toThrow('尚未完整');
    expect(() => validateRequirementReview({ ...review, checks: review.checks.map(check => ({ ...check, status: 'unsupported' })) }, 2)).toThrow('尚未完整');
  });
});
