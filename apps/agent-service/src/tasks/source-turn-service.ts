import type { WorkspacePersistence } from '../workspace/persistence';
import { SourceTurnProgressStore } from '../progress/source-turn-progress-store';

/** Single-process task ownership. Agent execution is supplied by the application. */
export class SourceTurnService {
  private readonly runs = new Map<string, { turnId: string; conversationId: string; controller: AbortController }>();

  constructor(readonly progress: SourceTurnProgressStore) {}

  get(workspaceId: string) {
    const run = this.runs.get(workspaceId);
    return run ? { turnId: run.turnId, conversationId: run.conversationId } : undefined;
  }
  has(workspaceId: string) { return this.runs.has(workspaceId); }

  start(workspaceId: string, turnId: string, conversationId: string, execute: (signal: AbortSignal) => Promise<void>): 'accepted' | 'busy' {
    if (this.progress.get(workspaceId, turnId)) return 'accepted';
    if (this.runs.has(workspaceId)) return 'busy';
    const controller = new AbortController();
    this.progress.start(workspaceId, turnId);
    this.runs.set(workspaceId, { turnId, conversationId, controller });
    void Promise.resolve().then(() => execute(controller.signal)).catch(error => {
      // Also catch failures in the application's logging/finalization path.
      const message = error instanceof Error ? error.message : '修改任务异常结束';
      try {
        this.progress.fail(workspaceId, turnId, message, { kind: 'failed', code: 'SOURCE_TURN_ERROR', message });
      } catch (failure) {
        console.error('[source-turn] Failed to persist terminal state', failure);
      }
    }).finally(() => { this.runs.delete(workspaceId); });
    return 'accepted';
  }

  async startPersisted(workspaceId: string, turnId: string, conversationId: string,
    execute: (signal: AbortSignal) => Promise<void>, persistence?: WorkspacePersistence): Promise<'accepted' | 'busy'> {
    if (!persistence) return this.start(workspaceId, turnId, conversationId, execute);
    if (this.progress.get(workspaceId, turnId)) return 'accepted';
    if (this.runs.has(workspaceId)) return 'busy';
    const controller = new AbortController();
    this.runs.set(workspaceId, { turnId, conversationId, controller });
    try {
      await persistence.run(workspaceId, () => { this.progress.start(workspaceId, turnId); });
    } catch (error) {
      this.runs.delete(workspaceId);
      throw error;
    }
    void Promise.resolve().then(() => execute(controller.signal)).catch(() => {
      this.progress.fail(workspaceId, turnId, '任务执行异常，结果未确认，请检查存储状态');
    }).finally(() => { this.runs.delete(workspaceId); });
    return 'accepted';
  }

  cancel(workspaceId: string, turnId: string): boolean {
    const run = this.runs.get(workspaceId);
    if (!run || run.turnId !== turnId) return false;
    try {
      this.progress.requestCancellation(workspaceId, turnId);
    } finally {
      run.controller.abort(new Error('用户取消本轮修改'));
    }
    return true;
  }
}
