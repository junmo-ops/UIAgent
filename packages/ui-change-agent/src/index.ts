import { PROTOCOL_VERSION, type AgentTurnResponse, type ChangePlan, type ExecutionSubmission, type StartTurnRequest, type VerificationResult } from '@ui-agent/contracts';
import type { AgentRuntime } from '@ui-agent/agent-runtime';

interface PendingTurn {
  request: StartTurnRequest;
  plan: ChangePlan;
  repairCount: number;
}

function check(code: string, passed: boolean, message: string) {
  return { code, passed, message };
}

export function verifyExecution(plan: ChangePlan, submission: ExecutionSubmission): VerificationResult {
  const plannedIds = plan.operations.map(operation => operation.operationId);
  const receiptIds = submission.receipt.operations.map(operation => operation.operationId);
  const checks = [
    check('PLAN_ID', submission.planId === plan.planId && submission.receipt.planId === plan.planId, '执行回执对应当前计划'),
    check('SELECTION_VERSION', submission.observation.selectionVersion === plan.selectionVersion, '执行后仍属于当前选区'),
    check('OPERATION_COVERAGE', plannedIds.every(id => receiptIds.includes(id)), '每个计划操作都有执行回执'),
    check('TRANSACTION_SUCCESS', submission.receipt.success, submission.receipt.success ? 'DOM 事务执行成功' : submission.receipt.error ?? 'DOM 事务执行失败'),
    check('OPERATION_STATUS', submission.receipt.operations.every(item => item.status === 'applied'), '所有原子操作均已应用且未回滚'),
    check('POSTCONDITIONS', submission.receipt.operations.every(item => item.verified), '所有原子操作的 DOM 后置条件均已满足'),
    check(
      'PAGE_REVISION',
      submission.receipt.success
        ? submission.receipt.pageRevision === submission.beforePageRevision + 1
          && submission.observation.pageRevision === submission.receipt.pageRevision
        : submission.receipt.pageRevision === submission.beforePageRevision,
      '页面版本与事务结果一致'
    )
  ];
  const passed = checks.every(item => item.passed);
  if (passed) return { status: 'passed', summary: `已验证 ${plannedIds.length} 个原子操作，页面结果与执行回执一致`, checks };
  const identitySafe = checks.find(item => item.code === 'PLAN_ID')?.passed
    && checks.find(item => item.code === 'SELECTION_VERSION')?.passed;
  const repairable = Boolean(identitySafe && !submission.receipt.success);
  return {
    status: repairable ? 'repairable' : 'failed',
    summary: checks.filter(item => !item.passed).map(item => item.message).join('；'),
    checks
  };
}

export class UiChangeAgent {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly finals = new Map<string, AgentTurnResponse>();

  constructor(private readonly runtime: AgentRuntime) {}

  async start(request: StartTurnRequest): Promise<AgentTurnResponse> {
    const final = this.finals.get(request.turnId);
    if (final) return final;
    const existing = this.pending.get(request.turnId);
    if (existing) return { kind: 'execution', plan: existing.plan, repairCount: existing.repairCount };
    const result = await this.runtime.invoke(request);
    if (result.kind === 'clarification') {
      const response: AgentTurnResponse = result;
      this.finals.set(request.turnId, response);
      return response;
    }
    this.pending.set(request.turnId, { request, plan: result.plan, repairCount: 0 });
    return { kind: 'execution', plan: result.plan, repairCount: 0 };
  }

  async resume(submission: ExecutionSubmission): Promise<AgentTurnResponse> {
    const final = this.finals.get(submission.turnId);
    if (final) return final;
    const pending = this.pending.get(submission.turnId);
    if (!pending) return { kind: 'failed', code: 'TURN_NOT_FOUND', message: '待恢复的 Agent Turn 不存在或已过期' };
    if (pending.request.editSessionId !== submission.editSessionId || pending.request.traceId !== submission.traceId) {
      return { kind: 'failed', code: 'TURN_MISMATCH', message: '执行结果与当前编辑会话不匹配' };
    }
    const verification = verifyExecution(pending.plan, submission);
    if (verification.status === 'passed') {
      const response: AgentTurnResponse = { kind: 'completed', verification };
      this.pending.delete(submission.turnId);
      this.finals.set(submission.turnId, response);
      return response;
    }
    if (verification.status !== 'repairable' || pending.repairCount >= 1) {
      const response: AgentTurnResponse = {
        kind: 'failed', code: 'VERIFICATION_ERROR',
        message: pending.repairCount >= 1 ? `自动修正后仍未通过验证：${verification.summary}` : verification.summary,
        verification
      };
      this.pending.delete(submission.turnId);
      this.finals.set(submission.turnId, response);
      return response;
    }

    const repairRequest: StartTurnRequest = {
      ...pending.request,
      protocolVersion: PROTOCOL_VERSION,
      turnId: `${pending.request.turnId}-repair-1`,
      instruction: [
        `原始目标：${pending.request.instruction}`,
        `上一次计划执行失败：${verification.summary}`,
        '请只生成仍在当前选区内的最小修正计划，不要重复已经成功的操作。'
      ].join('\n'),
      context: submission.observation
    };
    const repair = await this.runtime.invoke(repairRequest);
    if (repair.kind === 'clarification') {
      const response: AgentTurnResponse = repair;
      this.pending.delete(submission.turnId);
      this.finals.set(submission.turnId, response);
      return response;
    }
    this.pending.set(submission.turnId, { ...pending, plan: repair.plan, repairCount: 1 });
    return { kind: 'execution', plan: repair.plan, repairCount: 1, verification };
  }
}
