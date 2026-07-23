import { describe, expect, it } from 'vitest';
import type { ChallengeRunResult } from '@ui-agent/ui-change-eval';
import { challengeScenarios } from '@ui-agent/ui-change-eval';
import { markdownReport } from './report';

describe('challenge report', () => {
  it('summarizes scores, repairs, and failed checks', () => {
    const result: ChallengeRunResult = {
      scenario: challengeScenarios[0]!,
      turns: [{ kind: 'execution', repairCount: 1 }],
      score: {
        scenarioId: challengeScenarios[0]!.id,
        score: 72,
        passed: false,
        checks: [{
          dimension: 'outcome', code: 'FINAL_TEXT', passed: false,
          message: '最终页面缺少负责人'
        }]
      }
    };
    const report = markdownReport([{ repeat: 2, result }], {
      generatedAt: '2026-07-23T00:00:00.000Z',
      model: 'remote/deepseek',
      split: 'development'
    });
    expect(report).toContain('| C01-relative-double-filter | 2 | 72 | 失败 | 1 |');
    expect(report).toContain('outcome/FINAL_TEXT：最终页面缺少负责人');
  });
});
