import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AgentTurnResponse, type ExecutionSubmission, type StartTurnRequest } from '@ui-agent/contracts';
import type { CodingAgentPort } from '@ui-agent/agent-runtime';
import { createApp } from './app';
import { TurnLogStore } from './log-store';
import { SnapshotStore } from './snapshot-store';
import { SourceWorkspaceStore } from './source-workspace-store';

describe('agent service', () => {
  it('creates and serves a persistent static source workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-agent-app-workspace-'));
    try {
      const app = createApp(
        { MODEL_MODE: 'mock' },
        new TurnLogStore({ persist: false }),
        new SnapshotStore(),
        new SourceWorkspaceStore(root)
      );
      const response = await app.request('/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          title: '订单页 · 静态副本',
          sourceUrl: 'https://example.test/orders',
          capturedAt: '2026-07-29T10:00:00.000Z',
          html: '<!doctype html><html><body><button data-ui-source-id="source-0" style="color:red">查询</button></body></html>',
          nodeCount: 1,
          selectedSourceId: 'source-0',
          viewport: { width: 1280, height: 800 }
        })
      });
      expect(response.status).toBe(201);
      const created = await response.json() as { workspaceId: string; previewUrl: string };
      const info = await app.request(`/v1/workspaces/${created.workspaceId}`);
      expect(await info.json()).toMatchObject({ workspaceId: created.workspaceId, revision: 0, canUndo: false });
      const preview = await app.request(`/workspaces/${created.workspaceId}/preview`);
      expect(preview.headers.get('content-security-policy')).toContain("script-src 'none'");
      const previewHtml = await preview.text();
      expect(previewHtml).toContain('data-ui-source-id="source-0"');
      expect(previewHtml).toContain('<style data-ui-agent-workspace-styles>');
      expect(previewHtml).toContain('.ui-snapshot-style-0{color:red}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates and serves an isolated static snapshot', async () => {
    const app = createApp(
      { MODEL_MODE: 'mock' },
      new TurnLogStore({ persist: false }),
      new SnapshotStore()
    );
    const response = await app.request('/v1/snapshots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        title: '订单页 · 静态快照',
        sourceUrl: 'https://example.test/orders',
        capturedAt: '2026-07-29T10:00:00.000Z',
        html: '<!doctype html><html><body><button style="color:red">查询</button></body></html>',
        nodeCount: 1,
        selectedSourceId: 'source-0',
        viewport: { width: 1280, height: 800 }
      })
    });
    expect(response.status).toBe(201);
    const created = await response.json() as { snapshotId: string; previewUrl: string };
    expect(created.previewUrl).toContain(`/snapshots/${created.snapshotId}`);

    const preview = await app.request(`/snapshots/${created.snapshotId}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(await preview.text()).toContain('查询');
  });

  it('runs source turns through CodingAgentPort and records its checkpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-agent-coding-port-'));
    const logStore = new TurnLogStore({ persist: false });
    const codingAgent: CodingAgentPort = {
      adapterId: 'test-coding-agent',
      async run(turn, tools) {
        await tools.replaceInElement('source-0', '查询', '确定');
        const revision = await tools.commit('修改按钮文案');
        const response = {
          kind: 'completed' as const,
          summary: '已修改按钮文案',
          revision,
          modelCalls: 1,
          toolCalls: 1
        };
        return {
          response,
          steps: [{
            modelCall: 1,
            action: 'replaceInElement',
            decision: {
              action: 'replaceInElement',
              sourceId: 'source-0',
              search: '查询',
              replace: '确定',
              reason: '修改按钮文案'
            },
            result: '元素内替换成功'
          }],
          checkpoint: {
            version: 1,
            adapterId: 'test-coding-agent',
            workspaceId: turn.workspaceId,
            turnId: turn.request.turnId,
            status: 'completed',
            modelCalls: 1,
            toolCalls: 1,
            stepCount: 1,
            lastAction: 'replaceInElement',
            updatedAt: '2026-07-31T00:00:00.000Z'
          }
        };
      }
    };
    try {
      const app = createApp(
        { MODEL_MODE: 'mock' },
        logStore,
        new SnapshotStore(),
        new SourceWorkspaceStore(root),
        codingAgent
      );
      const createdResponse = await app.request('/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          title: '订单页 · 静态副本',
          sourceUrl: 'https://example.test/orders',
          capturedAt: '2026-07-31T00:00:00.000Z',
          html: '<!doctype html><html><body><button data-ui-source-id="source-0">查询</button></body></html>',
          nodeCount: 1,
          selectedSourceId: 'source-0',
          viewport: { width: 1280, height: 800 }
        })
      });
      const created = await createdResponse.json() as { workspaceId: string };
      const turnResponse = await app.request(`/v1/workspaces/${created.workspaceId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          editSessionId: 'source-session',
          turnId: 'source-turn-port',
          traceId: 'source-trace',
          instruction: '把查询改成确定',
          sourceId: 'source-0'
        })
      });

      expect(await turnResponse.json()).toMatchObject({ kind: 'completed', revision: 1 });
      const progressResponse = await app.request(
        `/v1/workspaces/${created.workspaceId}/turns/source-turn-port/progress`
      );
      expect(await progressResponse.json()).toMatchObject({
        status: 'completed',
        phase: 'finishing',
        modelCalls: 1,
        toolCalls: 1
      });
      const preview = await app.request(`/workspaces/${created.workspaceId}/preview`);
      expect(await preview.text()).toContain('确定');
      expect(logStore.get(logStore.list()[0]!.id)).toMatchObject({
        codingAgent: {
          adapterId: 'test-coding-agent',
          checkpoint: { status: 'completed', stepCount: 1 }
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns health and a mock plan without binding a port', async () => {
    const app = createApp({ MODEL_MODE: 'mock' }, new TurnLogStore({ persist: false }));
    const health = await app.request('/health');
    expect(await health.json()).toMatchObject({
      ok: true,
      modelMode: 'mock',
      codingAgentAdapter: 'legacy-source-agent'
    });
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
