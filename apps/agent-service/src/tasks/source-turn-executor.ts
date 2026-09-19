import type { CodingAgentPort } from '@ui-agent/agent-runtime';
import type { SourceTurnRequest } from '@ui-agent/contracts';
import type { SourceWorkspaceStore } from '../workspace/store';
import type { SourceTurnProgressStore } from '../progress/source-turn-progress-store';
import type { TurnLogStore } from '../observability/log-store';

interface SourceTurnExecutorDependencies {
  workspaceStore: SourceWorkspaceStore;
  codingAgent: CodingAgentPort;
  sourceProgress: SourceTurnProgressStore;
  logStore: TurnLogStore;
}

/** Application use case: no HTTP, authentication, URL construction or browser APIs. */
export function createSourceTurnExecutor({
  workspaceStore, codingAgent, sourceProgress, logStore
}: SourceTurnExecutorDependencies) {
  const recordLog: TurnLogStore['recordSourceTurn'] = (...args) => {
    try {
      logStore.recordSourceTurn(...args);
    } catch (error) {
      // Diagnostics must not turn a saved edit into a failed task, or prevent
      // an execution failure from publishing its terminal status.
      console.error('[source-turn] Failed to write diagnostic log', error);
    }
  };
  return async (
    workspaceId: string,
    request: SourceTurnRequest,
    signal: AbortSignal
  ) => {
    const startedAt = Date.now();
    let rollbackWorkspace: (() => Promise<void>) | undefined;
    try {
      signal.throwIfAborted();
      const conversation = workspaceStore.conversation(workspaceId, request.conversationId);
      const tools = workspaceStore.tools(workspaceId);
      rollbackWorkspace = tools.rollback;
      const run = await codingAgent.run(
        { workspaceId, request, conversation },
        tools,
        event => sourceProgress.observe(workspaceId, request.turnId, event),
        signal
      );
      const result = run.response;
      workspaceStore.recordTurn(workspaceId, request, result);
      recordLog(workspaceId, request, conversation, result, run.steps, Date.now() - startedAt, { adapterId: codingAgent.adapterId, checkpoint: run.checkpoint });
      sourceProgress.complete(workspaceId, request.turnId, result, run.checkpoint.modelCalls, run.checkpoint.toolCalls);
    } catch (error) {
      try {
        await rollbackWorkspace?.();
      } catch {
        // Release the editing session when possible; do not claim rollback succeeded.
      }
      const result = signal.aborted
        ? { kind: 'cancelled' as const, message: '已停止本轮修改，已保存的版本保留；修改结果请以当前副本为准。' }
        : { kind: 'failed' as const, code: 'SOURCE_TURN_ERROR', message: error instanceof Error ? error.message : '源码修改失败' };
      recordLog(workspaceId, request, [], result, [], Date.now() - startedAt);
      sourceProgress.fail(workspaceId, request.turnId, result.message, result);
    }
  };
}
