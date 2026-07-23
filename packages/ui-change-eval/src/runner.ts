import type { ChallengeScenario } from './scenarios';
import { scoreChallengeRun, type ChallengeScore, type ChallengeTurnResult } from './scorer';

export interface ChallengeDriver {
  startScenario(scenario: ChallengeScenario): Promise<void>;
  runTurn(scenario: ChallengeScenario, turnIndex: number, instruction: string): Promise<ChallengeTurnResult>;
  finishScenario(scenario: ChallengeScenario): Promise<void>;
}

export interface ChallengeRunResult {
  scenario: ChallengeScenario;
  turns: ChallengeTurnResult[];
  score: ChallengeScore;
}

export async function runChallengeScenario(
  scenario: ChallengeScenario,
  driver: ChallengeDriver
): Promise<ChallengeRunResult> {
  const turns: ChallengeTurnResult[] = [];
  await driver.startScenario(scenario);
  try {
    for (const [turnIndex, instruction] of scenario.instructionTurns.entries()) {
      const result = await driver.runTurn(scenario, turnIndex, instruction);
      turns.push(result);
      if (result.kind !== scenario.expectedResponse) break;
    }
  } finally {
    await driver.finishScenario(scenario);
  }
  return { scenario, turns, score: scoreChallengeRun(scenario, turns) };
}

export async function runChallengeSuite(
  scenarios: ChallengeScenario[],
  driver: ChallengeDriver
): Promise<ChallengeRunResult[]> {
  const results: ChallengeRunResult[] = [];
  for (const scenario of scenarios) results.push(await runChallengeScenario(scenario, driver));
  return results;
}
