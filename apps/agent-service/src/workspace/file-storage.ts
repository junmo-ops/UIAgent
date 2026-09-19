import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { refreshWorkspaceIndexes } from './compiler';
import { WORKSPACE_FILES, type WorkspaceFiles, type WorkspaceManifest } from './workspace-types';

/** Filesystem persistence only; no Agent, DOM editing, or revision decisions. */
export class WorkspaceFileStorage {
  constructor(readonly root: string) {}
  readOptionalFile(path: string): string | undefined {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }

  workspacePath(workspaceId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error('无效的 Workspace ID');
    const directory = resolve(this.root, workspaceId);
    if (!directory.startsWith(`${this.root}${sep}`)) throw new Error('Workspace 路径越界');
    return directory;
  }

  readWorkspaceFiles(directory: string): WorkspaceFiles {
    const html = readFileSync(resolve(directory, 'index.html'), 'utf8');
    const css = this.readOptionalFile(resolve(directory, 'snapshot.css')) ?? '';
    const generated = refreshWorkspaceIndexes(html);
    const moduleSource = readFileSync(resolve(directory, 'module.jsx'), 'utf8');
    return {
      'index.html': html,
      'snapshot.css': css,
      'author-overrides.css': this.readOptionalFile(resolve(directory, 'author-overrides.css')) ?? '',
      'module.jsx': moduleSource,
      'module.js': readFileSync(resolve(directory, 'module.js'), 'utf8'),
      'outline.json': this.readOptionalFile(resolve(directory, 'outline.json')) ?? generated.outline,
      'source-map.json': this.readOptionalFile(resolve(directory, 'source-map.json')) ?? generated.sourceMap
    };
  }

  deleteWorkspace(workspaceId: string): void {
    const directory = this.workspacePath(workspaceId);
    // Validate the actual target before recursive deletion, including junctions.
    const root = realpathSync(this.root);
    const target = realpathSync(directory);
    if (lstatSync(directory).isSymbolicLink() || dirname(target) !== root || basename(target) !== workspaceId) {
      throw new Error('副本删除路径越界或包含符号链接');
    }
    this.readManifest(directory);
    rmSync(directory, { recursive: true });
  }

  writeWorkspaceFiles(directory: string, files: WorkspaceFiles, atomic = false): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const path of WORKSPACE_FILES) {
      const target = resolve(directory, path);
      if (atomic) this.atomicWrite(target, files[path]);
      else writeFileSync(target, files[path], { encoding: 'utf8', mode: 0o600 });
    }
  }

  readManifest(directory: string): WorkspaceManifest {
    const manifest = JSON.parse(readFileSync(resolve(directory, 'workspace.json'), 'utf8')) as WorkspaceManifest;
    if (!manifest.conversation?.some(turn => turn.revision === undefined)) return manifest;

    // Workspace V2 initially stored conversations without a revision. Recover completed
    // turn revisions by matching their persisted summaries; clarification turns inherit
    // the latest known revision. This keeps existing workspaces undo-aware.
    const summaries = manifest.summaries.filter(item => item.revision > 0);
    let latestRevision = 0;
    const used = new Set<number>();
    return {
      ...manifest,
      conversation: manifest.conversation.map(turn => {
        if (turn.revision !== undefined) {
          latestRevision = Math.max(latestRevision, turn.revision);
          return turn;
        }
        const summary = summaries.find(item => !used.has(item.revision) && (
          turn.result.startsWith(item.summary) || item.summary.startsWith(turn.result)
        ));
        if (summary) {
          used.add(summary.revision);
          latestRevision = summary.revision;
        }
        return { ...turn, revision: latestRevision };
      })
    };
  }

  writeManifest(directory: string, manifest: WorkspaceManifest) {
    this.atomicWrite(resolve(directory, 'workspace.json'), JSON.stringify(manifest, null, 2));
  }

  atomicWrite(path: string, content: string | Uint8Array) {
    const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    if (typeof content === 'string') writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    else writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  }
}
