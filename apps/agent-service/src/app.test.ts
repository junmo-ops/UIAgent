import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type AgentTurnResponse, type ExecutionSubmission, type StartTurnRequest } from '@ui-agent/contracts';
import { createApp } from './app';
import { TurnLogStore } from './log-store';

describe('agent service', () => {
  it('returns health and a mock plan without binding a port', async () => {
    const app = createApp({ MODEL_MODE: 'mock' }, new TurnLogStore({ persist: false }));
    const health = await app.request('/health');
    expect(await health.json()).toMatchObject({ ok: true, modelMode: 'mock' });
    const request: StartTurnRequest = {
      protocolVersion: PROTOCOL_VERSION, editSessionId: 's', turnId: 't', traceId: 'trace', instruction: '添加一个“刷新”按钮',
      context: {
        protocolVersion: PROTOCOL_VERSION, selectionVersion: 1, pageRevision: 0,
        page: { title: 'test', url: 'http://localhost:5173', viewportWidth: 1200, viewportHeight: 800 },
        selected: { id: 'selected', tag: 'button', text: '查询', rect: { x: 1, y: 1, width: 80, height: 32 } },
        selectedTree: { id: 'selected', tag: 'button', text: '查询', attributes: {}, children: [] },
        reusableTrees: [],
        parent: { tag: 'div', display: 'flex', flexDirection: 'row', gap: '8px' }, siblings: [], visibleStyle: {}, addedElements: [], addedTrees: []
      }
    };
    const response = await app.request('/v1/turns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    const startResult = await response.json() as AgentTurnResponse;
    expect(startResult).toMatchObject({ kind: 'execution', plan: { requiresConfirmation: false }, repairCount: 0 });
    if (startResult.kind !== 'execution') throw new Error('expected execution plan');
    const createOperation = startResult.plan.operations.find(operation => operation.type === 'addComponent');
    if (!createOperation) throw new Error('expected add component operation');

    const submission: ExecutionSubmission = {
      protocolVersion: PROTOCOL_VERSION, editSessionId: 's', turnId: 't', traceId: 'trace',
      planId: startResult.plan.planId, beforePageRevision: 0,
      receipt: {
        protocolVersion: PROTOCOL_VERSION, planId: startResult.plan.planId, success: true, pageRevision: 1,
        appliedOperationIds: startResult.plan.operations.map(operation => operation.operationId),
        operations: startResult.plan.operations.map(operation => ({
          operationId: operation.operationId,
          status: 'applied' as const,
          verified: true,
          ...(operation.operationId === createOperation.operationId && { resultElementId: 'added-refresh' })
        }))
      },
      observation: {
        ...request.context,
        pageRevision: 1,
        addedElements: [{
          id: 'added-refresh', tag: 'button', text: '刷新',
          rect: { x: 90, y: 1, width: 80, height: 32 }
        }],
        addedTrees: [{
          id: 'added-refresh', tag: 'button', text: '刷新',
          attributes: { 'data-ui-component': 'button' }, children: []
        }],
        elementFacts: [
          {
            id: 'selected', parentId: 'parent', index: 0, text: '查询',
            rect: { x: 1, y: 1, width: 80, height: 32 },
            layout: { display: 'inline-flex', flexDirection: 'row', gridTemplateColumns: 'none', gap: '0px' }
          },
          {
            id: 'added-refresh', parentId: 'parent', index: 1, semanticRole: 'button', text: '刷新',
            rect: { x: 90, y: 1, width: 80, height: 32 },
            layout: { display: 'inline-flex', flexDirection: 'row', gridTemplateColumns: 'none', gap: '0px' }
          }
        ]
      }
    };
    const completionResponse = await app.request('/v1/turns/t/execution', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission)
    });
    expect(await completionResponse.json()).toMatchObject({ kind: 'completed', verification: { status: 'passed' } });

    const logsResponse = await app.request('/v1/logs');
    const logs = await logsResponse.json();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 'completed', instruction: '添加一个“刷新”按钮', traceId: 'trace' });

    const detailResponse = await app.request(`/v1/logs/${logs[0].id}`);
    expect(await detailResponse.json()).toMatchObject({
      request: { editSessionId: 's', instruction: '添加一个“刷新”按钮' },
      conversation: [],
      result: { kind: 'plan' },
      executions: [expect.objectContaining({ response: expect.objectContaining({ kind: 'completed' }) })]
    });

    const pageResponse = await app.request('/logs');
    expect(pageResponse.headers.get('content-type')).toContain('text/html');
    expect(await pageResponse.text()).toContain('UI Agent 会话日志');
  });
});
