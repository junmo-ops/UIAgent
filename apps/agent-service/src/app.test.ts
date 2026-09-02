import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@ui-agent/contracts';
import type { AssistantChatPort, AssistantRouterPort, CodingAgentPort } from '@ui-agent/agent-runtime';
import { createApp } from './app';
import { TurnLogStore } from './observability/log-store';
import { SourceWorkspaceStore } from './workspace/store';
import { staticAuthenticator } from './auth/authenticator';

const unusedCodingAgent: CodingAgentPort = {
  adapterId: 'unused-test-agent',
  async run() {
    throw new Error('This test does not run the coding agent');
  }
};

describe('agent service', () => {
  it('authenticates and delegates assistant turns without opening workspace tools', async () => {
    const received: unknown[] = [];
    const assistantRouter: AssistantRouterPort = {
      adapterId: 'test-assistant-router',
      async route(request) {
        received.push(request);
        return { kind: 'chat' };
      }
    };
    const assistantChat: AssistantChatPort = {
      adapterId: 'test-assistant-chat',
      async answer(_request, observeText) {
        observeText?.('这是普通');
        observeText?.('问答，不会修改页面。');
        return '这是普通问答，不会修改页面。';
      }
    };
    const app = createApp(
      {},
      new TurnLogStore({ persist: false }),
      undefined,
      unusedCodingAgent,
      staticAuthenticator({ userId: 'alice', tenantId: 'company-a', roles: ['user'] }),
      assistantRouter,
      assistantChat
    );
    const body = {
      protocolVersion: PROTOCOL_VERSION,
      turnId: '11111111-1111-4111-8111-111111111111',
      traceId: '22222222-2222-4222-8222-222222222222',
      instruction: '解释一下 flex-shrink',
      context: { hasWorkspace: false, hasSelection: false },
      conversation: []
    };

    const response = await app.request('/v1/assistant/turns/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const streamBody = await response.text();
    expect(streamBody).toContain('{"type":"answer_delta","text":"这是普通"}');
    expect(streamBody).toContain('{"type":"answer_delta","text":"问答，不会修改页面。"}');
    expect(streamBody).toContain('{"type":"result","result":{"kind":"answered","answer":"这是普通问答，不会修改页面。"}}');
    expect(received).toEqual([body]);
  });

  it('isolates every workspace resource by authenticated user and tenant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-agent-owner-isolation-'));
    try {
      const store = new SourceWorkspaceStore(root);
      const alice = createApp(
        {},
        new TurnLogStore({ persist: false }),
        store,
        unusedCodingAgent,
        staticAuthenticator({ userId: 'alice', tenantId: 'company-a', roles: ['user'] })
      );
      const bob = createApp(
        {},
        new TurnLogStore({ persist: false }),
        store,
        unusedCodingAgent,
        staticAuthenticator({ userId: 'bob', tenantId: 'company-a', roles: ['user'] })
      );
      const otherTenantAlice = createApp(
        {},
        new TurnLogStore({ persist: false }),
        store,
        unusedCodingAgent,
        staticAuthenticator({ userId: 'alice', tenantId: 'company-b', roles: ['user'] })
      );
      const createdResponse = await alice.request('/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          title: 'Alice workspace',
          sourceUrl: 'https://example.test/alice',
          capturedAt: '2026-08-08T00:00:00.000Z',
          html: '<!doctype html><html><body><main data-ui-source-id="source-0">Alice</main></body></html>',
          nodeCount: 1,
          selectedSourceId: 'source-0',
          viewport: { width: 1280, height: 800 }
        })
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { workspaceId: string };

      expect(await (await alice.request('/v1/workspaces')).json()).toMatchObject({ total: 1 });
      expect(await (await bob.request('/v1/workspaces')).json()).toMatchObject({ total: 0 });
      expect(await (await otherTenantAlice.request('/v1/workspaces')).json()).toMatchObject({ total: 0 });
      expect((await bob.request('/v1/logs')).status).toBe(403);

      for (const foreignApp of [bob, otherTenantAlice]) {
        expect((await foreignApp.request(`/v1/workspaces/${created.workspaceId}`)).status).toBe(404);
        expect((await foreignApp.request(`/workspaces/${created.workspaceId}/preview`)).status).toBe(404);
        expect((await foreignApp.request(`/v1/workspaces/${created.workspaceId}`, { method: 'DELETE' })).status).toBe(404);
        expect((await foreignApp.request(`/v1/workspaces/${created.workspaceId}/undo`, { method: 'POST' })).status).toBe(404);
        expect((await foreignApp.request(`/v1/workspaces/${created.workspaceId}/turns/unknown/progress`)).status).toBe(404);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed in production when no identity provider is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-agent-auth-required-'));
    try {
      const app = createApp(
        { NODE_ENV: 'production', AUTH_MODE: 'development' },
        new TurnLogStore({ persist: false }),
        new SourceWorkspaceStore(root),
        unusedCodingAgent
      );
      expect((await app.request('/v1/workspaces')).status).toBe(401);
      expect((await app.request('/v1/logs')).status).toBe(401);
      expect((await app.request('/health')).status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provisions signed installation identities without a database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-agent-installation-auth-'));
    try {
      const env = {
        NODE_ENV: 'production',
        AUTH_MODE: 'installation',
        INSTALLATION_TOKEN_SECRET: 'installation-test-secret-with-32-characters',
        PUBLIC_BASE_URL: 'https://ui-agent.example.test'
      };
      const app = createApp(
        env,
        new TurnLogStore({ persist: false }),
        new SourceWorkspaceStore(root),
        unusedCodingAgent
      );
      const issue = async () => {
        const response = await app.request('/v1/auth/installations', { method: 'POST' });
        expect(response.status).toBe(201);
        return await response.json() as { accessToken: string; expiresAt: string };
      };
      const first = await issue();
      const second = await issue();
      expect(first.accessToken).not.toBe(second.accessToken);

      const firstHeaders = {
        authorization: `Bearer ${first.accessToken}`,
        'content-type': 'application/json'
      };
      const createdResponse = await app.request('/v1/workspaces', {
        method: 'POST',
        headers: firstHeaders,
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          title: '安装身份的副本',
          sourceUrl: 'https://example.test/installation',
          capturedAt: '2026-08-08T00:00:00.000Z',
          html: '<!doctype html><html><body><main data-ui-source-id="source-0">Installation</main></body></html>',
          nodeCount: 1,
          selectedSourceId: 'source-0',
          viewport: { width: 1280, height: 800 }
        })
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { workspaceId: string; previewUrl: string };
      expect(new URL(created.previewUrl).searchParams.get('preview_token')).toBeTruthy();

      expect(await (await app.request('/v1/workspaces', { headers: firstHeaders })).json()).toMatchObject({ total: 1 });
      expect(await (await app.request('/v1/workspaces', {
        headers: { authorization: `Bearer ${second.accessToken}` }
      })).json()).toMatchObject({ total: 0 });
      expect((await app.request(`/v1/workspaces/${created.workspaceId}`, {
        headers: { authorization: `Bearer ${second.accessToken}` }
      })).status).toBe(404);

      expect((await app.request(created.previewUrl)).status).toBe(200);
      expect((await app.request(`/workspaces/${created.workspaceId}/preview`)).status).toBe(401);

      const refreshedResponse = await app.request('/v1/auth/installations/refresh', {
        method: 'POST',
        headers: { authorization: `Bearer ${first.accessToken}` }
      });
      expect(refreshedResponse.status).toBe(200);
      const refreshed = await refreshedResponse.json() as { accessToken: string };
      expect((await app.request('/v1/workspaces', {
        headers: { authorization: `Bearer ${refreshed.accessToken}` }
      })).status).toBe(200);

      const tampered = `${first.accessToken}x`;
      expect((await app.request('/v1/workspaces', {
        headers: { authorization: `Bearer ${tampered}` }
      })).status).toBe(401);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      const listed = await app.request('/v1/workspaces?query=orders');
      expect(await listed.json()).toMatchObject({
        total: 1,
        items: [expect.objectContaining({ workspaceId: created.workspaceId })]
      });
      const renamed = await app.request(`/v1/workspaces/${created.workspaceId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '订单筛选方案' })
      });
      expect(await renamed.json()).toMatchObject({ title: '订单筛选方案' });
      const preview = await app.request(`/workspaces/${created.workspaceId}/preview`);
      expect(preview.headers.get('content-security-policy')).toContain("script-src 'none'");
      const previewHtml = await preview.text();
      expect(previewHtml).toContain('data-ui-source-id="source-0"');
      expect(previewHtml).toContain('<style data-ui-agent-workspace-styles>');
      expect(previewHtml).toContain('.ui-snapshot-style-0{color:red}');
      const archive = await app.request('/v1/workspaces/export-all');
      expect(archive.status).toBe(200);
      expect(await archive.json()).toMatchObject({
        format: 'ui-agent-workspace-archive',
        workspaces: [expect.objectContaining({ snapshot: expect.objectContaining({ title: '订单筛选方案' }) })]
      });
      const removed = await app.request(`/v1/workspaces/${created.workspaceId}`, { method: 'DELETE' });
      expect(await removed.json()).toMatchObject({ workspaceId: created.workspaceId });
      expect((await app.request(`/v1/workspaces/${created.workspaceId}`)).status).toBe(404);
      expect((await app.request(`/workspaces/${created.workspaceId}/preview`)).status).toBe(404);
      expect(await (await app.request('/v1/workspaces?status=trashed')).json()).toMatchObject({ total: 1 });
      expect((await app.request('/v1/workspaces/export-all')).status).toBe(409);
      expect((await app.request(`/v1/workspaces/${created.workspaceId}/restore`, { method: 'POST' })).status).toBe(200);
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
        const { revision } = await tools.commit('修改按钮文案');
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

      expect(turnResponse.status).toBe(202);
      expect(await turnResponse.json()).toMatchObject({ kind: 'accepted', turnId: 'source-turn-port' });
      await expect.poll(async () => {
        const progressResponse = await app.request(
          `/v1/workspaces/${created.workspaceId}/turns/source-turn-port/progress`
        );
        return progressResponse.json();
      }).toMatchObject({
        status: 'completed',
        phase: 'finishing',
        modelCalls: 1,
        toolCalls: 1,
        result: { kind: 'completed', revision: 1 }
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
