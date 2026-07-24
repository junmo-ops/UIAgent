import {
  PROTOCOL_VERSION,
  type AgentTurnResponse,
  type ChangePlan,
  type ContextScope,
  type DomTreeNode,
  type ExecutionSubmission,
  type StartTurnRequest,
  type UiGoal,
  type VerificationResult
} from '@ui-agent/contracts';
import type { AgentRuntime } from '@ui-agent/agent-runtime';

interface PendingTurn {
  request: StartTurnRequest;
  plan: ChangePlan;
  repairCount: number;
  planningRound: number;
}

interface PlanningTurn {
  request: StartTurnRequest;
  planningRound: number;
  providedScopeKey: string;
  requestedScopes: ContextScope[];
  response: Extract<AgentTurnResponse, { kind: 'contextRequest' }>;
}

const MAX_PLANNING_ROUNDS = 5;

function scopeKey(request: StartTurnRequest): string {
  return [
    request.context.selectionVersion,
    request.context.pageRevision,
    [...(request.context.contextScopes ?? [])].sort().join(',')
  ].join(':');
}

function check(code: string, passed: boolean, message: string) {
  return { code, passed, message };
}

function indexObservationTrees(submission: ExecutionSubmission): Map<string, DomTreeNode> {
  const nodes = new Map<string, DomTreeNode>();
  const visit = (node: DomTreeNode) => {
    nodes.set(node.id, node);
    node.children.forEach(visit);
  };
  visit(submission.observation.selectedTree);
  submission.observation.addedTrees.forEach(visit);
  return nodes;
}

function producerForResult(plan: ChangePlan, resultRef: string) {
  return plan.operations.find(operation =>
    (operation.type === 'cloneSubtree' || operation.type === 'addComponent')
    && operation.resultRef === resultRef
  );
}

function resolveTargetNodeId(
  target: UiGoal['target'],
  resultRef: string | undefined,
  plan: ChangePlan,
  submission: ExecutionSubmission
): string | undefined {
  if (target?.kind === 'node') return target.nodeId;
  const resolvedResultRef = resultRef ?? (target?.kind === 'result' ? target.resultRef : undefined);
  if (!resolvedResultRef) return undefined;
  const producer = producerForResult(plan, resolvedResultRef);
  if (!producer) return undefined;
  return submission.receipt.operations.find(item => item.operationId === producer.operationId)?.resultElementId;
}

function resolveGoalNodeId(goal: UiGoal, plan: ChangePlan, submission: ExecutionSubmission): string | undefined {
  return resolveTargetNodeId(goal.target, goal.resultRef, plan, submission);
}

function treeText(node: DomTreeNode): string {
  return [node.text, ...node.children.map(treeText)].filter(Boolean).join(' ');
}

function treeAttributes(node: DomTreeNode): Record<string, string>[] {
  return [node.attributes, ...node.children.flatMap(treeAttributes)];
}

function hasSemanticRole(node: DomTreeNode, role: UiGoal['role']): boolean {
  if (role === 'row') return node.tag === 'tr' || node.role === 'row';
  if (role === 'field' || role === 'container') return true;
  const semantic = treeAttributes(node).map(attributes => attributes['data-ui-component']).filter(Boolean);
  if (semantic.some(value => value === role || value?.endsWith(`-${role}`) || value === `labeled-${role}`)) return true;
  if (role === 'text') return treeText(node).trim().length > 0;
  if (role === 'button') return node.tag === 'button' || node.children.some(child => hasSemanticRole(child, role));
  if (role === 'link') return node.tag === 'a' || node.children.some(child => hasSemanticRole(child, role));
  if (role === 'input') return node.tag === 'input' || node.children.some(child => hasSemanticRole(child, role));
  if (role === 'select') return node.tag === 'select' || node.role === 'combobox' || node.children.some(child => hasSemanticRole(child, role));
  if (role === 'checkboxGroup') {
    return treeAttributes(node).some(attributes => attributes.type === 'checkbox')
      || node.children.some(child => hasSemanticRole(child, role));
  }
  if (role === 'radioGroup') {
    return treeAttributes(node).some(attributes => attributes.type === 'radio')
      || node.children.some(child => hasSemanticRole(child, role));
  }
  return false;
}

function placementSatisfied(goal: UiGoal, nodeId: string, plan: ChangePlan, submission: ExecutionSubmission): boolean {
  if (!goal.placement) return true;
  const facts = submission.observation.elementFacts ?? [];
  const node = facts.find(fact => fact.id === nodeId);
  const anchorId = resolveTargetNodeId(goal.placement.anchor, undefined, plan, submission);
  const resolvedAnchor = facts.find(fact => fact.id === anchorId);
  if (!node || !resolvedAnchor) return false;
  const relation = goal.placement.relation;
  const strict = goal.placement.strict;
  const structurallyPlaced = relation === 'before'
    ? node.parentId === resolvedAnchor.parentId && (strict ? node.index + 1 === resolvedAnchor.index : node.index < resolvedAnchor.index)
    : relation === 'after'
      ? node.parentId === resolvedAnchor.parentId && (strict ? node.index === resolvedAnchor.index + 1 : node.index > resolvedAnchor.index)
      : relation === 'insideStart'
        ? node.parentId === resolvedAnchor.id && node.index === 0
        : node.parentId === resolvedAnchor.id
          && node.index === Math.max(...facts.filter(fact => fact.parentId === resolvedAnchor.id).map(fact => fact.index));
  if (!structurallyPlaced) return false;
  if (!goal.placement.sameRow) return true;
  const overlap = Math.min(node.rect.y + node.rect.height, resolvedAnchor.rect.y + resolvedAnchor.rect.height)
    - Math.max(node.rect.y, resolvedAnchor.rect.y);
  return overlap > 0;
}

function verifyIntentGoals(plan: ChangePlan, submission: ExecutionSubmission) {
  if (!plan.intent) return [];
  const nodes = indexObservationTrees(submission);
  const allText = treeText(submission.observation.selectedTree)
    + submission.observation.addedTrees.map(treeText).join(' ')
    + submission.observation.siblings.map(sibling => sibling.text).join(' ')
    + (submission.observation.elementFacts ?? []).map(fact => fact.text ?? '').join(' ');
  return plan.intent.goals.flatMap(goal => {
    const nodeId = resolveGoalNodeId(goal, plan, submission);
    const node = nodeId ? nodes.get(nodeId) : undefined;
    const checks = [];
    if (goal.action !== 'remove') {
      checks.push(check(`GOAL_${goal.goalId}_TARGET`, Boolean(node), `目标 ${goal.goalId} 的结果元素存在`));
    }
    if (node) {
      const text = treeText(node);
      checks.push(check(`GOAL_${goal.goalId}_ROLE`, hasSemanticRole(node, goal.role), `目标 ${goal.goalId} 保留 ${goal.role} 组件语义`));
      for (const [field, value] of Object.entries(goal.content)) {
        if (value === undefined) continue;
        const passed = field === 'variant'
          ? treeAttributes(node).some(attributes => attributes['data-ui-agent-variant'] === value)
          : field === 'options'
            ? (value as string[]).every(option => text.includes(option)
              || treeAttributes(node).some(attributes => attributes['data-ui-agent-options']?.includes(option)))
            : text.includes(String(value))
              || treeAttributes(node).some(attributes => Object.values(attributes).includes(String(value)));
        checks.push(check(`GOAL_${goal.goalId}_CONTENT_${field.toUpperCase()}`, passed, `目标 ${goal.goalId} 的 ${field} 达到预期`));
      }
      checks.push(check(
        `GOAL_${goal.goalId}_PLACEMENT`,
        placementSatisfied(goal, nodeId!, plan, submission),
        `目标 ${goal.goalId} 的严格相对位置达到预期`
      ));
      if (goal.state) {
        const attrs = treeAttributes(node);
        const passed = goal.state.name === 'disabled'
          ? attrs.some(attributes => attributes.disabled === String(goal.state?.value) || attributes['aria-disabled'] === String(goal.state?.value))
          : goal.state.name === 'open'
            ? attrs.some(attributes => attributes['aria-expanded'] === String(goal.state?.value))
            : (goal.state.options ?? []).every(option =>
              text.includes(option)
              && attrs.some(attributes => attributes['aria-selected'] === String(goal.state?.value)
                || attributes['aria-checked'] === String(goal.state?.value)
                || attributes['data-ui-agent-selected-options']?.includes(option))
            );
        checks.push(check(`GOAL_${goal.goalId}_STATE`, passed, `目标 ${goal.goalId} 的 ${goal.state.name} 状态达到预期`));
      }
    }
    for (const preserveText of goal.preserveTexts) {
      checks.push(check(
        `GOAL_${goal.goalId}_PRESERVE`,
        allText.includes(preserveText),
        `保持约束中的“${preserveText}”仍然存在`
      ));
    }
    return checks;
  });
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
    ),
    ...verifyIntentGoals(plan, submission)
  ];
  const passed = checks.every(item => item.passed);
  if (passed) return { status: 'passed', summary: `已验证 ${plannedIds.length} 个原子操作，页面结果与执行回执一致`, checks };
  const identitySafe = checks.find(item => item.code === 'PLAN_ID')?.passed
    && checks.find(item => item.code === 'SELECTION_VERSION')?.passed;
  const preserveFailed = checks.some(item => item.code.endsWith('_PRESERVE') && !item.passed);
  const repairable = Boolean(identitySafe && !preserveFailed);
  return {
    status: repairable ? 'repairable' : 'failed',
    summary: checks.filter(item => !item.passed).map(item => item.message).join('；'),
    checks
  };
}

export class UiChangeAgent {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly planning = new Map<string, PlanningTurn>();
  private readonly finals = new Map<string, AgentTurnResponse>();

  constructor(private readonly runtime: AgentRuntime) {}

  async start(request: StartTurnRequest): Promise<AgentTurnResponse> {
    const final = this.finals.get(request.turnId);
    if (final) return final;
    const existing = this.pending.get(request.turnId);
    if (existing) return { kind: 'execution', plan: existing.plan, repairCount: existing.repairCount };
    const planning = this.planning.get(request.turnId);
    if (planning) {
      if (planning.request.editSessionId !== request.editSessionId || planning.request.traceId !== request.traceId) {
        return { kind: 'failed', code: 'TURN_MISMATCH', message: '补充上下文与当前编辑会话不匹配' };
      }
      const nextScopeKey = scopeKey(request);
      if (nextScopeKey === planning.providedScopeKey) return planning.response;
      const provided = new Set(request.context.contextScopes ?? []);
      if (!planning.requestedScopes.every(scope => provided.has(scope))) return planning.response;
    }
    const planningRound = (planning?.planningRound ?? 0) + 1;
    const result = await this.runtime.invoke(request);
    if (result.kind === 'contextRequest') {
      const provided = new Set(request.context.contextScopes ?? []);
      const requestedScopes = [...new Set(result.contextRequest.scopes)]
        .filter(scope => !provided.has(scope));
      if (requestedScopes.length === 0 || planningRound >= MAX_PLANNING_ROUNDS) {
        const response: AgentTurnResponse = {
          kind: 'failed',
          code: requestedScopes.length === 0 ? 'CONTEXT_NO_PROGRESS' : 'CONTEXT_ROUND_LIMIT',
          message: requestedScopes.length === 0
            ? 'Agent 重复申请已提供的页面上下文，已停止本轮规划'
            : `Agent 在 ${MAX_PLANNING_ROUNDS} 轮内仍无法生成可靠计划`
        };
        this.planning.delete(request.turnId);
        this.finals.set(request.turnId, response);
        return response;
      }
      const response: Extract<AgentTurnResponse, { kind: 'contextRequest' }> = {
        kind: 'contextRequest',
        contextRequest: { ...result.contextRequest, scopes: requestedScopes },
        planningRound
      };
      this.planning.set(request.turnId, {
        request,
        planningRound,
        providedScopeKey: scopeKey(request),
        requestedScopes,
        response
      });
      return response;
    }
    if (result.kind === 'clarification') {
      const response: AgentTurnResponse = result;
      this.planning.delete(request.turnId);
      this.finals.set(request.turnId, response);
      return response;
    }
    this.planning.delete(request.turnId);
    this.pending.set(request.turnId, { request, plan: result.plan, repairCount: 0, planningRound });
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
    if (verification.status !== 'repairable' || pending.repairCount >= 1 || pending.planningRound >= MAX_PLANNING_ROUNDS) {
      const response: AgentTurnResponse = {
        kind: 'failed', code: 'VERIFICATION_ERROR',
        message: pending.repairCount >= 1
          ? `自动修正后仍未通过验证：${verification.summary}`
          : pending.planningRound >= MAX_PLANNING_ROUNDS
            ? `已达到 ${MAX_PLANNING_ROUNDS} 轮规划上限：${verification.summary}`
            : verification.summary,
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
    if (repair.kind === 'contextRequest') {
      const response: AgentTurnResponse = {
        kind: 'failed',
        code: 'REPAIR_CONTEXT_REQUIRED',
        message: `安全修正还需要额外页面上下文：${repair.contextRequest.reason}`
      };
      this.pending.delete(submission.turnId);
      this.finals.set(submission.turnId, response);
      return response;
    }
    if (repair.kind === 'clarification') {
      const response: AgentTurnResponse = repair;
      this.pending.delete(submission.turnId);
      this.finals.set(submission.turnId, response);
      return response;
    }
    this.pending.set(submission.turnId, {
      ...pending,
      plan: repair.plan,
      repairCount: 1,
      planningRound: pending.planningRound + 1
    });
    return { kind: 'execution', plan: repair.plan, repairCount: 1, verification };
  }
}
