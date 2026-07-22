import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type StartTurnRequest } from '@ui-agent/contracts';
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
    expect(await response.json()).toMatchObject({ kind: 'plan', plan: { requiresConfirmation: false } });

    const logsResponse = await app.request('/v1/logs');
    const logs = await logsResponse.json();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 'completed', instruction: '添加一个“刷新”按钮', traceId: 'trace' });

    const detailResponse = await app.request(`/v1/logs/${logs[0].id}`);
    expect(await detailResponse.json()).toMatchObject({
      request: { editSessionId: 's', instruction: '添加一个“刷新”按钮' },
      conversation: [],
      result: { kind: 'plan' }
    });

    const pageResponse = await app.request('/logs');
    expect(pageResponse.headers.get('content-type')).toContain('text/html');
    expect(await pageResponse.text()).toContain('UI Agent 会话日志');
  });
});
