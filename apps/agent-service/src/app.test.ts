import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@ui-agent/contracts';
import type { CodingAgentPort } from '@ui-agent/agent-runtime';
import { createApp } from './app';
import { TurnLogStore } from './observability/log-store';
import { SourceWorkspaceStore } from './workspace/store';

describe('agent service', () => {
  it('creates and serves a persistent static source workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-agent-app-workspace-'));
    try {
      const app = createApp(
        {
          MODEL_MODE: 'remote',
          MODEL_BASE_URL: 'https://example.test',
          MODEL_API_KEY: 'test-key',
          MODEL_NAME: 'test-model',
          PUBLIC_BASE_URL: 'https://ui-agent.example.test'
        },
        new TurnLogStore({ persist: false }),
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
      expect(created.previewUrl).toBe(`https://ui-agent.example.test/workspaces/${created.workspaceId}/preview`);
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
            input: { sourceId: 'source-0', search: '查询', replace: '确定' },
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

  it('returns health for the configured source agent', async () => {
    const app = createApp({
      MODEL_MODE: 'remote',
      MODEL_BASE_URL: 'https://example.test',
      MODEL_API_KEY: 'test-key',
      MODEL_NAME: 'test-model'
    }, new TurnLogStore({ persist: false }));
    const health = await app.request('/health');
    expect(await health.json()).toMatchObject({
      ok: true,
      modelMode: 'remote',
      codingAgentAdapter: 'cline-sdk'
    });
    expect((await app.request('/v1/turns', { method: 'POST' })).status).toBe(404);
    const pageResponse = await app.request('/logs');
    expect(pageResponse.headers.get('content-type')).toContain('text/html');
    expect(await pageResponse.text()).toContain('UI Agent 会话日志');
  });
});
