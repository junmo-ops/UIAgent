import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type SourceTurnRequest, type StartTurnRequest } from '@ui-agent/contracts';
import { TurnLogStore } from './log-store';

const request: StartTurnRequest = {
  protocolVersion: PROTOCOL_VERSION,
  editSessionId: 'session-log', turnId: 'turn-log', traceId: 'trace-log', instruction: '新增一行订单',
  context: {
    protocolVersion: PROTOCOL_VERSION, selectionVersion: 1, pageRevision: 0,
    page: { title: '订单', url: 'http://127.0.0.1:5173', viewportWidth: 1200, viewportHeight: 800 },
    selected: { id: 'selected', tag: 'div', text: '订单列表', rect: { x: 0, y: 0, width: 800, height: 400 } },
    selectedTree: { id: 'selected', tag: 'div', text: '订单列表', attributes: {}, children: [] },
    reusableTrees: [], parent: { tag: 'main', display: 'block', flexDirection: 'row', gap: 'normal' },
    siblings: [], visibleStyle: { apiKey: 'must-not-leak' }, addedElements: [], addedTrees: []
  }
};

describe('TurnLogStore', () => {
  it('persists completed turns, reloads the latest snapshot, and redacts sensitive keys', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ui-agent-log-'));
    const filePath = join(directory, 'turns.jsonl');
    const store = new TurnLogStore({ filePath, model: { mode: 'remote', provider: 'deepseek', name: 'deepseek-v4-flash' } });
    store.observe({ type: 'turn.started', timestamp: '2026-07-22T00:00:00.000Z', request, conversation: [] });
    store.observe({
      type: 'model.attempt.failed',
      timestamp: '2026-07-22T00:00:00.500Z',
      request,
      attempt: 1,
      durationMs: 500,
      promptChars: 1200,
      systemChars: 9000,
      error: 'schema mismatch'
    });
    store.observe({
      type: 'turn.completed', timestamp: '2026-07-22T00:00:01.000Z', request, conversation: [], durationMs: 1000,
      result: { kind: 'clarification', clarification: { protocolVersion: PROTOCOL_VERSION, reason: 'test', question: 'test' } }
    });

    const persisted = readFileSync(filePath, 'utf8');
    expect(persisted).not.toContain('must-not-leak');
    expect(persisted).toContain('[REDACTED]');

    const reloaded = new TurnLogStore({ filePath });
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]).toMatchObject({ status: 'completed', editSessionId: 'session-log', durationMs: 1000 });
    const detail = reloaded.get(reloaded.list()[0]!.id);
    expect(detail?.modelAttempts).toEqual([expect.objectContaining({
      status: 'failed',
      attempt: 1,
      durationMs: 500,
      promptChars: 1200,
      error: 'schema mismatch'
    })]);
  });

  it('records source workspace requests and restricted file-tool steps', () => {
    const store = new TurnLogStore({
      persist: false,
      model: { mode: 'remote', provider: 'deepseek', name: 'deepseek-v4-flash' }
    });
    const sourceRequest: SourceTurnRequest = {
      protocolVersion: PROTOCOL_VERSION,
      editSessionId: 'source-session',
      turnId: 'source-turn',
      traceId: 'source-trace',
      instruction: '把查询改成确定',
      sourceId: 'source-0'
    };
    store.recordSourceTurn(
      '11111111-1111-4111-8111-111111111111',
      sourceRequest,
      [],
      { kind: 'completed', summary: '已修改按钮', revision: 1, modelCalls: 2, toolCalls: 1 },
      [{
        modelCall: 1,
        action: 'search',
        decision: { action: 'search', query: 'source-0', reason: '定位目标' },
        result: '命中字符 100'
      }],
      850,
      {
        adapterId: 'legacy-source-agent',
        checkpoint: {
          version: 1,
          adapterId: 'legacy-source-agent',
          workspaceId: '11111111-1111-4111-8111-111111111111',
          turnId: 'source-turn',
          status: 'completed',
          modelCalls: 2,
          toolCalls: 1,
          stepCount: 1,
          lastAction: 'finish',
          updatedAt: '2026-07-22T00:00:00.850Z'
        }
      }
    );
    expect(store.list()[0]).toMatchObject({
      instruction: '把查询改成确定',
      resultKind: 'completed',
      durationMs: 850
    });
    expect(store.get(store.list()[0]!.id)).toMatchObject({
      sourceWorkspaceId: '11111111-1111-4111-8111-111111111111',
      codingAgent: { adapterId: 'legacy-source-agent', checkpoint: { status: 'completed' } },
      sourceSteps: [expect.objectContaining({ modelCall: 1 })]
    });
  });
});
