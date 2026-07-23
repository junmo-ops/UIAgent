import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  challengeScenarios,
  runChallengeSuite,
  type ChallengeScenario
} from '@ui-agent/ui-change-eval';
import { ChromeChallengeDriver } from './chrome-driver';
import { parseOptions } from './options';
import { markdownReport, type RepeatedChallengeResult } from './report';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function assertService(url: string): Promise<{ modelMode?: string; modelName?: string }> {
  try {
    const response = await fetch(`${url}/health`);
    if (!response.ok) throw new Error(String(response.status));
    return await response.json() as { modelMode?: string; modelName?: string };
  } catch {
    throw new Error(`Agent Service 不可用：${url}。请先运行 pnpm dev:service`);
  }
}

async function assertPage(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
  } catch {
    throw new Error(`固定测试页不可用：${url}。请先运行 pnpm dev:page`);
  }
}

function selectScenarios(
  split: 'development' | 'holdout' | 'all',
  scenarioIds: string[]
): ChallengeScenario[] {
  const selected = challengeScenarios.filter(scenario =>
    (split === 'all' || scenario.split === split)
    && (scenarioIds.length === 0 || scenarioIds.includes(scenario.id))
  );
  const unknown = scenarioIds.filter(id => !challengeScenarios.some(scenario => scenario.id === id));
  if (unknown.length) throw new Error(`未知场景：${unknown.join(', ')}`);
  if (!selected.length) throw new Error('当前筛选条件下没有挑战场景');
  return selected;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const [health] = await Promise.all([
    assertService(options.serviceUrl),
    assertPage(options.pageUrl)
  ]);
  const scenarios = selectScenarios(options.split, options.scenarioIds);
  const driver = new ChromeChallengeDriver({
    extensionPath: join(repositoryRoot, 'apps/extension/.output/chrome-mv3'),
    pageUrl: options.pageUrl,
    serviceUrl: options.serviceUrl,
    keepBrowser: options.keepBrowser
  });
  const results: RepeatedChallengeResult[] = [];
  try {
    await driver.open();
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      const run = await runChallengeSuite(scenarios, driver);
      results.push(...run.map(result => ({ repeat, result })));
      for (const item of run) {
        console.log(`[challenge] ${item.scenario.id} repeat=${repeat} score=${item.score.score} ${item.score.passed ? 'PASS' : 'FAIL'}`);
      }
    }
  } finally {
    await driver.close();
  }

  const generatedAt = new Date().toISOString();
  const model = `${health.modelMode ?? 'unknown'}${health.modelName ? `/${health.modelName}` : ''}`;
  const report = markdownReport(results, { generatedAt, model, split: options.split });
  const outputDirectory = join(repositoryRoot, 'output/playwright/challenge-runs');
  await mkdir(outputDirectory, { recursive: true });
  const timestamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = join(outputDirectory, `${timestamp}.json`);
  const markdownPath = join(outputDirectory, `${timestamp}.md`);
  await Promise.all([
    writeFile(jsonPath, JSON.stringify({ generatedAt, model, options, results }, null, 2)),
    writeFile(markdownPath, report)
  ]);
  console.log(`[challenge] report=${markdownPath}`);
  if (results.some(item => !item.result.score.passed)) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

export { selectScenarios };
