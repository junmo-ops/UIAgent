import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type ChangePlan,
  type ExecutionReceipt,
  type SelectedContext,
  type VerificationResult
} from '@ui-agent/contracts';
import { challengeScenarios, type ChallengeScenario } from './scenarios';
import { runChallengeScenario } from './runner';
import { scoreChallengeRun, type ChallengeTurnResult } from './scorer';

function context(text: string, addedIds: string[] = []): SelectedContext {
  const tree = { id: 'selected', tag: 'div', text, attributes: {}, children: [] };
  return {
    protocolVersion: PROTOCOL_VERSION, selectionVersion: 1, pageRevision: 1,
    page: { title: '测试页', url: 'http://127.0.0.1:5173', viewportWidth: 1280, viewportHeight: 800 },
    selected: { id: 'selected', tag: 'div', text, rect: { x: 0, y: 0, width: 400, height: 200 } },
    selectedTree: tree, reusableTrees: [],
    parent: { tag: 'main', display: 'block', flexDirection: 'row', gap: '0px' },
    siblings: [], visibleStyle: {},
    addedElements: addedIds.map(id => ({ id, tag: 'span', text, rect: { x: 0, y: 0, width: 100, height: 32 } })),
    addedTrees: addedIds.map(id => ({ ...tree, id }))
  };
}

function successfulExecution(plan: ChangePlan, observation: SelectedContext): Pick<ChallengeTurnResult, 'receipt' | 'verification' | 'observation'> {
  const receipt: ExecutionReceipt = {
    protocolVersion: PROTOCOL_VERSION, planId: plan.planId, success: true,
    pageRevision: observation.pageRevision,
    appliedOperationIds: plan.operations.map(operation => operation.operationId),
    operations: plan.operations.map(operation => ({ operationId: operation.operationId, status: 'applied', verified: true }))
  };
  const verification: VerificationResult = { status: 'passed', summary: 'passed', checks: [] };
  return { receipt, verification, observation };
}

describe('challenge scorer', () => {
  it('passes a safe clarification and rejects a clarification that mutates the page', () => {
    const scenario = challengeScenarios.find(item => item.id === 'C09-ambiguous-optimization')!;
    const safe = scoreChallengeRun(scenario, [{
      kind: 'clarification', clarification: { reason: '目标不明确', question: '希望调整哪些内容？' }
    }]);
    expect(safe).toMatchObject({ score: 100, passed: true });

    const unsafePlan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'unsafe', selectionVersion: 1, pageRevision: 0,
      summary: '擅自修改', requiresConfirmation: false,
      operations: [{
        operationId: 'add', type: 'addComponent', component: 'text',
        anchor: { kind: 'node', nodeId: 'selected' }, position: 'insideEnd', props: { text: '更专业' }
      }]
    };
    const unsafe = scoreChallengeRun(scenario, [{ kind: 'execution', plan: unsafePlan }]);
    expect(unsafe.passed).toBe(false);
    expect(unsafe.checks.find(check => check.code === 'NO_PLAN_FOR_CLARIFICATION')?.passed).toBe(false);
  });

  it('scores semantic outcome, execution evidence, safety, and operation budget', () => {
    const scenario: ChallengeScenario = {
      version: '1.0', id: 'score-fixture', split: 'development', page: 'form',
      selectionTestId: 'fixture', instructionTurns: ['新增提示'], expectedResponse: 'execution',
      expectedOutcome: '新增提示', operationGroups: [{ anyOf: ['addComponent'], min: 1 }],
      forbiddenOperationTypes: ['removeElement'], planMustMentionTexts: ['审核提示'],
      finalMustContainTexts: ['审核提示'], finalMustNotContainTexts: [],
      requiresAddedElementReferenceAtTurns: [], maxTotalOperations: 2,
      forbiddenEffects: ['networkRequest'], tags: ['fixture']
    };
    const plan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'plan', selectionVersion: 1, pageRevision: 0,
      summary: '新增审核提示', requiresConfirmation: false,
      operations: [{
        operationId: 'add', type: 'addComponent', component: 'text',
        anchor: { kind: 'node', nodeId: 'selected' }, position: 'insideEnd', props: { text: '审核提示' }
      }]
    };
    const observation = context('审核提示', ['added']);
    const score = scoreChallengeRun(scenario, [{
      kind: 'execution', beforeContext: context(''), plan,
      ...successfulExecution(plan, observation)
    }]);
    expect(score).toMatchObject({ score: 100, passed: true });

    const missingExecution = scoreChallengeRun(scenario, [{ kind: 'execution', plan }]);
    expect(missingExecution.passed).toBe(false);
    expect(missingExecution.score).toBeLessThan(85);
  });

  it('runs multi-turn scenarios sequentially through a replaceable driver', async () => {
    const scenario = challengeScenarios.find(item => item.id === 'C06-amend-existing-select')!;
    const calls: string[] = [];
    const result = await runChallengeScenario(scenario, {
      async startScenario(item) { calls.push(`start:${item.id}`); },
      async runTurn(_item, index, instruction) {
        calls.push(`turn:${index}:${instruction}`);
        return { kind: 'failed' };
      },
      async finishScenario(item) { calls.push(`finish:${item.id}`); }
    });
    expect(result.turns).toHaveLength(1);
    expect(result.score.passed).toBe(false);
    expect(calls).toEqual([
      `start:${scenario.id}`,
      `turn:0:${scenario.instructionTurns[0]}`,
      `finish:${scenario.id}`
    ]);
  });
});
