import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packWorkspace, restoreWorkspace } from '../storage/workspace-archive';
import { S3WorkspaceStorage, WorkspaceCommitUncertain, WorkspaceStorageError } from '../storage/s3-workspace-storage';

type Transaction = { root: string; publish: Array<() => void> };
export class WorkspacePersistence {
  private readonly context = new AsyncLocalStorage<Transaction>();
  private readonly busy = new Set<string>();
  private readonly blocked = new Set<string>();
  private currentRoot: string;
  ready = false;
  constructor(private readonly base: string, readonly remote: S3WorkspaceStorage) { this.currentRoot = resolve(base, 'current'); }
  get root() { return this.context.getStore()?.root ?? this.currentRoot; }
  get inTransaction() { return Boolean(this.context.getStore()); }
  get activeWrites() { return this.busy.size; }
  get healthy() { return this.ready && !this.blocked.size; }
  afterCommit(publish: () => void) {
    const transaction = this.context.getStore();
    if (transaction) transaction.publish.push(publish);
    else publish();
  }
  assertAvailable(id?: string) {
    if (!this.ready || (id ? this.blocked.has(id) : this.blocked.size > 0)) throw new WorkspaceCommitUncertain();
  }
  async initialize() {
    const marker = resolve(this.base, '.uiagent-s3-cache.json');
    if (existsSync(this.base) && lstatSync(this.base).isSymbolicLink()) throw new Error('缓存目录不能是符号链接');
    mkdirSync(this.base, { recursive: true, mode: 0o700 });
    if (existsSync(marker)) {
      const config = JSON.parse(readFileSync(marker, 'utf8'));
      if (config.location !== this.remote.location || config.version !== 1) throw new Error('缓存目录属于不同存储配置，请使用空缓存目录');
    } else {
      if (readdirSync(this.base).length) throw new Error('本地目录含有未迁移数据，请先备份迁移并配置空缓存目录');
      writeFileSync(marker, JSON.stringify({ version: 1, location: this.remote.location }), { mode: 0o600, flag: 'wx' });
    }
    await this.remote.assertDeletionPolicy();
    await this.remote.verifyAccess();
    const restored = mkdtempSync(resolve(this.base, 'restore-'));
    try {
      for (const id of await this.remote.list()) {
        const archive = await this.remote.read(id);
        if (!archive) throw new WorkspaceStorageError('列举到的副本无法读取，停止初始化');
        restoreWorkspace(archive, resolve(restored, id));
      }
      // A generation is enabled only after every object has been validated.
      this.currentRoot = restored;
      this.ready = true;
    } catch (error) {
      rmSync(restored, { recursive: true, force: true });
      throw error;
    }
    // Only managed generations are removed, never an unmarked legacy directory.
    for (const entry of readdirSync(this.base)) {
      const path = resolve(this.base, entry);
      if (path !== restored && /^(restore-|stage-)/.test(entry)) rmSync(path, { recursive: true, force: true });
    }
  }
  async run<T>(id: string | undefined, operation: () => T | Promise<T>, options: { commit?: () => boolean; signal?: AbortSignal } = {}): Promise<T> {
    if (this.inTransaction) throw new Error('禁止嵌套副本提交');
    this.assertAvailable(id);
    const lockId = id ?? `create-${randomUUID()}`;
    if (this.busy.has(lockId)) throw new WorkspaceStorageError('副本正在保存或修改，请稍后重试', 'WORKSPACE_BUSY');
    this.busy.add(lockId);
    let stage: string;
    try { stage = mkdtempSync(resolve(this.base, 'stage-')); }
    catch (error) { this.busy.delete(lockId); throw error; }
    const transaction: Transaction = { root: stage, publish: [] };
    let targetId = id;
    let committed = false;
    try {
      if (id) {
        const source = resolve(this.currentRoot, id);
        if (!existsSync(source)) throw new WorkspaceStorageError('副本不存在');
        cpSync(source, resolve(stage, id), { recursive: true, dereference: false });
      }
      const result = await this.context.run(transaction, operation);
      if (options.commit && !options.commit()) return result;
      options.signal?.throwIfAborted();
      if (!targetId) {
        const entries = readdirSync(stage);
        if (entries.length !== 1) throw new Error('创建副本必须产生一个工作区');
        targetId = entries[0]!;
      }
      const directory = resolve(stage, targetId);
      if (existsSync(directory)) {
        let snapshot: ReturnType<typeof packWorkspace>;
        try { snapshot = packWorkspace(directory, targetId, this.remote.limits); }
        catch { throw new WorkspaceStorageError('副本归档校验失败或超过容量限制，请检查文件完整性及容量配置', 'WORKSPACE_ARCHIVE_INVALID'); }
        const { archive, body } = snapshot;
        await this.remote.put(targetId, body, archive.commitId);
      } else {
        await this.remote.delete(targetId);
      }
      committed = true;
      const destination = resolve(this.currentRoot, targetId);
      const old = resolve(stage, '.previous');
      if (existsSync(destination)) renameSync(destination, old);
      if (existsSync(directory)) renameSync(directory, destination);
      for (const publish of transaction.publish) publish();
      return result;
    } catch (error) {
      if (committed || error instanceof WorkspaceCommitUncertain) {
        this.blocked.add(targetId ?? lockId);
        throw new WorkspaceCommitUncertain();
      }
      throw error;
    } finally {
      this.busy.delete(lockId);
      try { rmSync(stage, { recursive: true, force: true }); }
      catch { console.warn('[workspace-storage] 暂存缓存清理失败，将在重启时清理'); }
    }
  }
}
