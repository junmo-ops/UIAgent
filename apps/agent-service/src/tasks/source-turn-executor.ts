import type { CodingAgentPort } from '@ui-agent/agent-runtime';
import type { SourceTurnRequest, SourceTurnResponse } from '@ui-agent/contracts';
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
    let completedRun: Awaited<ReturnType<CodingAgentPort['run']>> | undefined;
    let runConversation: Parameters<TurnLogStore['recordSourceTurn']>[2] = [];
    let executionFailure: Extract<SourceTurnResponse, { kind: 'failed' | 'cancelled' }> | undefined;
    let rollbackWorkspace: (() => Promise<void>) | undefined;
    const perform = async () => {
      signal.throwIfAborted();
      const conversation = workspaceStore.conversation(workspaceId, request.conversationId);
      runConversation = conversation;
      const tools = workspaceStore.tools(workspaceId);
      rollbackWorkspace = tools.rollback;
      const run = await codingAgent.run(
        { workspaceId, request, conversation },
        tools,
        event => sourceProgress.observe(workspaceId, request.turnId, event),
        signal
      );
      completedRun = run;
      const result = run.response;
      if (workspaceStore.persistence && (result.kind === 'failed' || result.kind === 'cancelled')) {
        executionFailure = result;
        throw new Error(result.message);
      }
      workspaceStore.recordTurn(workspaceId, request, result);
      const logResult = () => recordLog(workspaceId, request, conversation, result, run.steps, Date.now() - startedAt, { adapterId: codingAgent.adapterId, checkpoint: run.checkpoint });
      if (workspaceStore.persistence) workspaceStore.persistence.afterCommit(logResult);
      else logResult();
      sourceProgress.complete(workspaceId, request.turnId, result, run.checkpoint.modelCalls, run.checkpoint.toolCalls);
    };
    try {
      if (workspaceStore.persistence) await workspaceStore.persistence.run(workspaceId, perform, { signal });
      else await perform();
    } catch (error) {
      try {
        await rollbackWorkspace?.();
      } catch {
        // Release the editing session when possible; do not claim rollback succeeded.
      }
      const result = executionFailure ?? (signal.aborted
        ? { kind: 'cancelled' as const, message: '已停止本轮修改，已保存的版本保留；修改结果请以当前副本为准。' }
        : { kind: 'failed' as const, code: 'SOURCE_TURN_ERROR', message: error instanceof Error ? error.message : '源码修改失败' });
      recordLog(workspaceId, request, runConversation, result, completedRun?.steps ?? [], Date.now() - startedAt,
        completedRun ? { adapterId: codingAgent.adapterId, checkpoint: completedRun.checkpoint } : undefined);
      if (workspaceStore.persistence) {
        try {
          await workspaceStore.persistence.run(workspaceId, () => {
            sourceProgress.fail(workspaceId, request.turnId, result.message, result);
          });
        } catch {
          sourceProgress.fail(workspaceId, request.turnId, '本轮结果未持久化，请检查对象存储；已确认版本保留。', {
            kind: 'failed', code: 'WORKSPACE_STORAGE_UNAVAILABLE', message: '任务保存结果未确认，请检查存储状态后重新查询副本。'
          });
        }
      } else sourceProgress.fail(workspaceId, request.turnId, result.message, result);
    }
  };
}
