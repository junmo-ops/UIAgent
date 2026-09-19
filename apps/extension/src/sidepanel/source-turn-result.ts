import type { SourceTurnResponse } from '@ui-agent/contracts';
import type { WorkspaceClarificationPrompt } from '../session/source-workspace-session';

type SettledSourceTurn = SourceTurnResponse;

interface ResultEffects<Workspace extends { revision: number }> {
  refresh(workspace: Workspace): Promise<Workspace>;
  reload(): Promise<unknown>;
  append(text: string, clarification: WorkspaceClarificationPrompt | undefined, revision: number, entryId: string): Promise<unknown>;
  clarify(prompt: WorkspaceClarificationPrompt): void;
}

/** Shared by a newly submitted turn and a turn recovered after reopening the panel. */
export function createSourceTurnResultHandler<Workspace extends { revision: number }>(effects: ResultEffects<Workspace>) {
  return async (outcome: SettledSourceTurn, workspace: Workspace, entryId: string): Promise<void> => {
    switch (outcome.kind) {
      case 'completed': {
        const current = await effects.refresh(workspace);
        await effects.append(outcome.summary, undefined, current.revision, entryId);
        if (!outcome.unchanged) await effects.reload();
        return;
      }
      case 'clarification': {
        const prompt: WorkspaceClarificationPrompt = {
          clarificationId: outcome.clarificationId ?? crypto.randomUUID(),
          options: outcome.options,
          allowFreeText: outcome.allowFreeText
        };
        effects.clarify(prompt);
        await effects.append(outcome.question, prompt, workspace.revision, entryId);
        return;
      }
      case 'cancelled':
        await effects.append(outcome.message, undefined, workspace.revision, entryId);
        return;
      case 'failed': {
        const interrupted = outcome.code === 'SOURCE_TURN_INTERRUPTED';
        const current = interrupted ? await effects.refresh(workspace) : workspace;
        if (interrupted) await effects.reload();
        await effects.append(`本轮修改未完成：${outcome.message}`, undefined, current.revision, entryId);
        return;
      }
      default: {
        const unhandled: never = outcome;
        throw new Error(`未知任务结果：${JSON.stringify(unhandled)}`);
      }
    }
  };
}
