import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type SourceTurnRequest } from '@ui-agent/contracts';
import type { CodingAgentCheckpoint, CodingAgentEvent } from '@ui-agent/agent-runtime';
import { SourceTurnProgressStore } from './source-turn-progress-store';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const request: SourceTurnRequest = {
  protocolVersion: PROTOCOL_VERSION,
  editSessionId: 'session',
  turnId: 'turn',
  traceId: 'trace',
  instruction: '新增性别筛选项',
  sourceId: 'source-41'
};

function checkpoint(): CodingAgentCheckpoint {
  return {
    version: 1,
    adapterId: 'cline-sdk',
    workspaceId,
    turnId: request.turnId,
    status: 'running',
    modelCalls: 2,
    toolCalls: 1,
    stepCount: 1,
    lastAction: 'apply_patch',
    updatedAt: '2026-07-31T02:00:01.000Z'
  };
}

describe('SourceTurnProgressStore', () => {
  it('tracks model waiting, tool starts and per-call details without replacing cancellation', () => {
    const store = new SourceTurnProgressStore();
    store.start(workspaceId, request.turnId);
    const timestamp = new Date().toISOString();
    const call = { modelCall: 1, startedAt: timestamp, status: 'running' as const };
    store.observe(workspaceId, request.turnId, { type: 'coding-agent.model.updated', timestamp, call });
    expect(store.get(workspaceId, request.turnId)?.message).toContain('规划下一步');
    store.observe(workspaceId, request.turnId, { type: 'coding-agent.tool.started', timestamp, action: 'insert_element', modelCall: 1 });
    expect(store.get(workspaceId, request.turnId)?.phase).toBe('editing');
    store.observe(workspaceId, request.turnId, { type: 'coding-agent.model.updated', timestamp, call: { ...call, reasoning: 'provider text' } });
    store.requestCancellation(workspaceId, request.turnId);
    store.observe(workspaceId, request.turnId, { type: 'coding-agent.model.updated', timestamp,
      call: { ...call, status: 'failed', durationMs: 100 } });
    expect(store.get(workspaceId, request.turnId)).toMatchObject({ status: 'cancelling',
      modelDetails: [{ status: 'failed', durationMs: 100, reasoning: 'provider text' }] });
  });
  it('projects agent tool events into user-safe progress summaries', () => {
    const store = new SourceTurnProgressStore();
    store.start(workspaceId, request.turnId);
    const stepEvent: CodingAgentEvent = {
      type: 'coding-agent.step.completed',
      timestamp: '2026-07-31T02:00:01.000Z',
      adapterId: 'cline-sdk',
      workspaceId,
      step: {
        modelCall: 2,
        action: 'apply_patch',
        input: {
          path: 'snapshot.css',
          edits: [{ kind: 'insert', position: 'end', text: '.dropdown{}' }]
        },
        result: 'Patch 成功'
      }
    };
    store.observe(workspaceId, request.turnId, stepEvent);
    store.observe(workspaceId, request.turnId, {
      type: 'coding-agent.checkpoint.updated',
      timestamp: '2026-07-31T02:00:01.000Z',
      checkpoint: checkpoint()
    });

    expect(store.get(workspaceId, request.turnId)).toMatchObject({
      status: 'running',
      phase: 'editing',
      message: '应用源码补丁…',
      modelCalls: 2,
      toolCalls: 1,
      activities: [{
        action: 'apply_patch',
        label: '应用源码补丁',
        detail: 'snapshot.css',
        status: 'completed'
      }]
    });
  });

  it('marks tool failures as strategy adjustment without exposing raw replacement content', () => {
    const store = new SourceTurnProgressStore();
    store.start(workspaceId, request.turnId);
    store.observe(workspaceId, request.turnId, {
      type: 'coding-agent.step.completed',
      timestamp: '2026-07-31T02:00:01.000Z',
      adapterId: 'cline-sdk',
      workspaceId,
      step: {
        modelCall: 2,
        action: 'replace_text',
        input: { path: 'snapshot.css', search: 'secret source', replace: 'secret replacement' },
        error: '原文不唯一'
      }
    });

    const progress = store.get(workspaceId, request.turnId)!;
    expect(progress.message).toContain('正在调整策略');
    expect(JSON.stringify(progress)).not.toContain('secret source');
    expect(progress.activities[0]).toMatchObject({ status: 'failed', detail: 'snapshot.css' });
  });

  it('keeps cancellation visible until the agent has rolled back its working copy', () => {
    const store = new SourceTurnProgressStore();
    store.start(workspaceId, request.turnId);

    expect(store.requestCancellation(workspaceId, request.turnId)).toMatchObject({
      status: 'cancelling',
      phase: 'finishing',
      message: '正在停止本轮修改…'
    });

    store.complete(workspaceId, request.turnId, {
      kind: 'cancelled',
      message: '已停止本轮修改，未提交任何变更。'
    }, 2, 1);

    expect(store.get(workspaceId, request.turnId)).toMatchObject({
      status: 'cancelled',
      phase: 'finishing',
      message: '已停止本轮修改，未提交变更',
      result: { kind: 'cancelled' }
    });
  });
});
