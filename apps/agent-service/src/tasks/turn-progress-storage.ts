import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sourceTurnProgressSchema, type SourceTurnProgress } from '@ui-agent/contracts';

/** Task records live inside the workspace, so permanent deletion removes them too. */
export class TurnProgressStorage {
  constructor(private readonly root: string) {}

  private directory(workspaceId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error('无效的 Workspace ID');
    return resolve(this.root, workspaceId, 'turns');
  }

  private path(workspaceId: string, turnId: string): string {
    return resolve(this.directory(workspaceId), `${createHash('sha256').update(turnId).digest('hex')}.json`);
  }

  read(workspaceId: string, turnId: string): SourceTurnProgress | undefined {
    const path = this.path(workspaceId, turnId);
    if (!existsSync(path)) return undefined;
    const value = sourceTurnProgressSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (value.workspaceId !== workspaceId || value.turnId !== turnId) throw new Error('任务记录与请求不一致');
    return value;
  }

  write(value: SourceTurnProgress): void {
    const directory = this.directory(value.workspaceId);
    // Never recreate a deleted workspace as a side effect of late task events.
    if (!existsSync(resolve(directory, '..', 'workspace.json'))) throw new Error('工作区不存在，无法保存任务状态');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = this.path(value.workspaceId, value.turnId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  }
}
