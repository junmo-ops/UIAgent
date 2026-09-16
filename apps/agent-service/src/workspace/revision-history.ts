import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkspaceFileStorage } from './file-storage';
import { validateWorkspaceFiles } from './workspace-validation';
import type { WorkspaceFiles } from './workspace-types';

/** Revision decisions live here; callers guard active edit sessions. */
export class WorkspaceRevisionHistory {
  constructor(private readonly storage: WorkspaceFileStorage) {}

  restore(workspaceId: string, direction: -1 | 1): void {
    const directory = this.storage.workspacePath(workspaceId);
    const manifest = this.storage.readManifest(directory);
    const target = manifest.revision + direction;
    if (target < 0 || target > manifest.maxRevision) throw new Error(direction < 0 ? '没有可撤销的版本' : '没有可重做的版本');
    this.restoreRevision(directory, target);
  }

  reset(workspaceId: string): void {
    this.restoreRevision(this.storage.workspacePath(workspaceId), 0);
  }

  private restoreRevision(directory: string, revision: number): void {
    const manifest = this.storage.readManifest(directory);
    const files = this.storage.readWorkspaceFiles(resolve(directory, 'revisions', String(revision).padStart(3, '0')));
    validateWorkspaceFiles(files);
    this.storage.writeWorkspaceFiles(directory, files, true);
    this.storage.writeManifest(directory, { ...manifest, revision, updatedAt: new Date().toISOString() });
  }

  commit(workspaceId: string, files: WorkspaceFiles, summary: string): number {
    const directory = this.storage.workspacePath(workspaceId);
    const manifest = this.storage.readManifest(directory);
    validateWorkspaceFiles(files);
    const revision = manifest.revision + 1;
    const revisionsRoot = resolve(directory, 'revisions');
    for (const entry of readdirSync(revisionsRoot)) {
      const value = Number(entry);
      if (Number.isInteger(value) && value >= revision) rmSync(resolve(revisionsRoot, entry), { recursive: true, force: true });
    }
    const revisionDirectory = resolve(revisionsRoot, String(revision).padStart(3, '0'));
    mkdirSync(revisionDirectory, { recursive: true, mode: 0o700 });
    this.storage.writeWorkspaceFiles(revisionDirectory, files);
    this.storage.writeWorkspaceFiles(directory, files, true);
    const now = new Date().toISOString();
    this.storage.writeManifest(directory, {
      ...manifest,
      updatedAt: now,
      revision,
      maxRevision: revision,
      summaries: [
        ...manifest.summaries.filter(item => item.revision < revision),
        { revision, summary, timestamp: now }
      ]
    });
    return revision;
  }
}
