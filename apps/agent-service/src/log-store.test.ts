import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type SourceTurnRequest } from '@ui-agent/contracts';
import { TurnLogStore } from './log-store';

describe('TurnLogStore', () => {
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
