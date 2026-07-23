import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ChangePlan, type ExecutionSubmission, type StartTurnRequest, type UiIntent } from '@ui-agent/contracts';
import type { AgentRuntime } from '@ui-agent/agent-runtime';
import { UiChangeAgent, verifyExecution } from './index';

const request: StartTurnRequest = {
  protocolVersion: PROTOCOL_VERSION, editSessionId: 'session', turnId: 'turn', traceId: 'trace', instruction: '添加刷新按钮',
  context: {
    protocolVersion: PROTOCOL_VERSION, selectionVersion: 1, pageRevision: 0,
    page: { title: 'test', url: 'http://localhost', viewportWidth: 1200, viewportHeight: 800 },
    selected: { id: 'selected', tag: 'div', text: '', rect: { x: 0, y: 0, width: 100, height: 40 } },
    selectedTree: { id: 'selected', tag: 'div', text: '', attributes: {}, children: [] }, reusableTrees: [],
    parent: { tag: 'main', display: 'block', flexDirection: 'row', gap: '0px' }, siblings: [], visibleStyle: {}, addedElements: [], addedTrees: []
  }
};

function plan(planId = 'plan-1', pageRevision = 0): ChangePlan & { intent: UiIntent } {
  return {
    protocolVersion: PROTOCOL_VERSION, planId, selectionVersion: 1, pageRevision,
    summary: '添加刷新按钮',
    intent: {
      summary: '验证两阶段执行',
      goals: [{
        goalId: 'selected-region', action: 'present', role: 'container',
        target: { kind: 'node', nodeId: 'selected' }, content: {}, preserveTexts: []
      }]
    },
    requiresConfirmation: false,
    operations: [{ operationId: `op-${planId}`, type: 'addComponent', anchor: { kind: 'node', nodeId: 'selected' }, component: 'button', position: 'after', props: { text: '刷新' } }]
  };
}

function submission(changePlan: ChangePlan, success: boolean): ExecutionSubmission {
  return {
    protocolVersion: PROTOCOL_VERSION, editSessionId: 'session', turnId: 'turn', traceId: 'trace',
    planId: changePlan.planId, beforePageRevision: changePlan.pageRevision,
    receipt: {
      protocolVersion: PROTOCOL_VERSION, planId: changePlan.planId, success,
      pageRevision: success ? changePlan.pageRevision + 1 : changePlan.pageRevision,
      appliedOperationIds: success ? changePlan.operations.map(operation => operation.operationId) : [],
      operations: changePlan.operations.map(operation => ({
        operationId: operation.operationId,
        status: success ? 'applied' as const : 'failed' as const,
        verified: success,
        ...(!success && { errorCode: 'EXECUTION_ERROR', errorMessage: 'target disconnected' })
      })),
      ...(!success && { error: 'target disconnected' })
    },
    observation: { ...request.context, pageRevision: success ? changePlan.pageRevision + 1 : changePlan.pageRevision }
  };
}

describe('UI Change Agent two-phase turn', () => {
  it('completes after a successful browser receipt passes deterministic verification', async () => {
    const initialPlan = plan();
    const runtime: AgentRuntime = { invoke: async () => ({ kind: 'plan', plan: initialPlan }) };
    const agent = new UiChangeAgent(runtime);
    await expect(agent.start(request)).resolves.toMatchObject({ kind: 'execution', plan: { planId: 'plan-1' } });
    await expect(agent.resume(submission(initialPlan, true))).resolves.toMatchObject({ kind: 'completed', verification: { status: 'passed' } });
  });

  it('generates at most one repair plan after a rolled-back execution', async () => {
    const plans = [plan(), plan('plan-repair', 0)];
    let calls = 0;
    const runtime: AgentRuntime = { invoke: async () => ({ kind: 'plan', plan: plans[calls++]! }) };
    const agent = new UiChangeAgent(runtime);
    await agent.start(request);
    const repair = await agent.resume(submission(plans[0]!, false));
    expect(repair).toMatchObject({ kind: 'execution', repairCount: 1, plan: { planId: 'plan-repair' }, verification: { status: 'repairable' } });
    await expect(agent.resume(submission(plans[1]!, false))).resolves.toMatchObject({ kind: 'failed', code: 'VERIFICATION_ERROR' });
    expect(calls).toBe(2);
  });
});

describe('verifyExecution', () => {
  it('rejects receipts for a different plan', () => {
    const changePlan = plan();
    const wrong = submission(changePlan, true);
    wrong.planId = 'other';
    expect(verifyExecution(changePlan, wrong)).toMatchObject({ status: 'failed' });
  });

  it('rejects a structurally successful receipt when the declared UI goal is not satisfied', () => {
    const intentPlan: ChangePlan & { intent: UiIntent } = {
      protocolVersion: PROTOCOL_VERSION, planId: 'goal-plan', selectionVersion: 1, pageRevision: 0,
      summary: '新增风险等级',
      intent: {
        summary: '新增风险等级',
        goals: [{
          goalId: 'risk', action: 'create', role: 'tag', resultRef: 'risk-result',
          content: { label: '风险等级', text: '高风险', variant: 'danger' },
          placement: {
            anchor: { kind: 'node', nodeId: 'selected' },
            relation: 'after', strict: true, sameRow: true
          },
          preserveTexts: []
        }]
      },
      requiresConfirmation: false,
      operations: [{
        operationId: 'create-risk', type: 'addComponent',
        anchor: { kind: 'node', nodeId: 'selected' }, component: 'tag',
        position: 'after', resultRef: 'risk-result',
        props: { label: '风险等级', text: '高风险', variant: 'danger' }
      }]
    };
    const result = submission(intentPlan, true);
    result.receipt.operations[0]!.resultElementId = 'added-risk';
    result.observation = {
      ...result.observation,
      selectedTree: { ...result.observation.selectedTree, text: '原字段' },
      addedTrees: [{
        id: 'added-risk', tag: 'span', text: '高风险',
        attributes: { 'data-ui-component': 'text' }, children: []
      }],
      elementFacts: [
        {
          id: 'selected', parentId: 'parent', index: 0,
          rect: { x: 0, y: 0, width: 100, height: 32 },
          layout: { display: 'block', flexDirection: 'row', gridTemplateColumns: 'none', gap: '0px' }
        },
        {
          id: 'added-risk', parentId: 'parent', index: 1,
          rect: { x: 100, y: 0, width: 100, height: 32 },
          layout: { display: 'block', flexDirection: 'row', gridTemplateColumns: 'none', gap: '0px' }
        }
      ]
    };

    const verification = verifyExecution(intentPlan, result);
    expect(verification.status).toBe('repairable');
    expect(verification.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GOAL_risk_ROLE', passed: false }),
      expect.objectContaining({ code: 'GOAL_risk_CONTENT_LABEL', passed: false }),
      expect.objectContaining({ code: 'GOAL_risk_CONTENT_VARIANT', passed: false })
    ]));

    result.observation.addedTrees = [{
      id: 'added-risk', tag: 'div', text: '',
      attributes: {
        'data-ui-component': 'labeled-tag',
        'data-ui-agent-variant': 'danger'
      },
      children: [
        { id: 'risk-label', tag: 'span', text: '风险等级', attributes: {}, children: [] },
        {
          id: 'risk-value', tag: 'span', text: '高风险',
          attributes: { 'data-ui-component': 'tag' }, children: []
        }
      ]
    }];
    expect(verifyExecution(intentPlan, result)).toMatchObject({ status: 'passed' });
  });
});
