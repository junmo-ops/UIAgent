import type { ChallengeRunResult } from '@ui-agent/ui-change-eval';

export interface RepeatedChallengeResult {
  repeat: number;
  result: ChallengeRunResult;
}

export function markdownReport(
  results: RepeatedChallengeResult[],
  metadata: { generatedAt: string; model: string; split: string }
): string {
  const passed = results.filter(item => item.result.score.passed).length;
  const average = results.length
    ? Math.round(results.reduce((sum, item) => sum + item.result.score.score, 0) / results.length)
    : 0;
  const lines = [
    '# UI Agent C 组挑战评测报告',
    '',
    `- 时间：${metadata.generatedAt}`,
    `- 模型：${metadata.model}`,
    `- 分组：${metadata.split}`,
    `- 通过：${passed} / ${results.length}`,
    `- 平均分：${average}`,
    '',
    '| 场景 | 轮次 | 分数 | 结果 | 自动修复 |',
    '| --- | ---: | ---: | --- | ---: |'
  ];
  for (const item of results) {
    const repairs = item.result.turns.reduce((sum, turn) => sum + (turn.repairCount ?? 0), 0);
    lines.push(`| ${item.result.scenario.id} | ${item.repeat} | ${item.result.score.score} | ${item.result.score.passed ? '通过' : '失败'} | ${repairs} |`);
  }
  const failures = results.flatMap(item =>
    item.result.score.checks
      .filter(check => !check.passed)
      .map(check => ({ id: item.result.scenario.id, repeat: item.repeat, ...check }))
  );
  if (failures.length) {
    lines.push('', '## 失败检查', '');
    for (const failure of failures) {
      lines.push(`- ${failure.id} 第 ${failure.repeat} 轮 · ${failure.dimension}/${failure.code}：${failure.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
