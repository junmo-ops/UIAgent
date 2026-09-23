import { readWorkspaceStorageConfig } from './config';
import { existsSync, lstatSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { contentFingerprint, packWorkspace, workspaceIdPattern } from './workspace-archive';
import { S3WorkspaceStorage } from './s3-workspace-storage';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, apply: { type: 'boolean', default: false }, report: { type: 'string' }
} });
if (!values.source) throw new Error('用法：storage:migrate --source /备份/source-workspaces [--apply] [--report /独立目录/迁移记录.json]');
const source = resolve(values.source);
const reportPath = values.report ? resolve(values.report) : undefined;
if (reportPath && (reportPath === source || reportPath.startsWith(`${source}/`))) throw new Error('迁移记录不能写入源数据目录');
const report: { mode: string; completed: boolean; workspaces: Array<{ id: string; fingerprint: string; files: number; bytes: number; status: string }> } = {
  mode: values.apply ? 'apply' : 'preflight', completed: false, workspaces: []
};
const saveReport = () => {
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
};
async function migrate() {
  if (!existsSync(source) || !lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new Error('源目录无效或包含符号链接');
  if (existsSync(resolve(source, '.uiagent-s3-cache.json'))) throw new Error('请使用旧版本完整工作区备份，不要迁移 S3 缓存根目录');
  const config = readWorkspaceStorageConfig();
  const remote = values.apply ? new S3WorkspaceStorage(process.env, config) : undefined;
  const limits = config.archive;
  // Preflight every local workspace before the first remote mutation.
  for (const id of readdirSync(source).sort()) {
    if (!workspaceIdPattern.test(id)) throw new Error('源目录含有无法识别的条目，请核对完整备份目录');
    const { archive, body } = packWorkspace(resolve(source, id), id, limits);
    report.workspaces.push({ id, fingerprint: contentFingerprint(archive), files: archive.files.length, bytes: body.length, status: 'validated' });
  }
  saveReport();
  if (remote) {
    await remote.assertDeletionPolicy();
    // Refuse all known conflicts before writing any objects.
    for (const entry of report.workspaces) {
      const existing = await remote.read(entry.id);
      if (existing && contentFingerprint(existing) !== entry.fingerprint) throw new Error(`远端副本内容冲突：${entry.id}；禁止覆盖`);
      if (existing) entry.status = 'already-present';
    }
    for (const entry of report.workspaces) {
      if (entry.status === 'already-present') continue;
      const { archive, body } = packWorkspace(resolve(source, entry.id), entry.id, limits);
      if (contentFingerprint(archive) !== entry.fingerprint) throw new Error('源目录在迁移期间发生变化，请停止写入后重试');
      await remote.put(entry.id, body, archive.commitId);
      const stored = await remote.read(entry.id);
      if (!stored || contentFingerprint(stored) !== entry.fingerprint) throw new Error('迁移回读校验失败');
      entry.status = 'uploaded-and-verified';
      saveReport();
    }
  }
  report.completed = true;
  saveReport();
  console.log(JSON.stringify(report, null, 2));
}
void migrate().catch(error => {
  saveReport();
  console.error(error instanceof Error && !('requestId' in error) ? error.message : '对象存储迁移失败，请检查部署配置和权限');
  process.exitCode = 1;
});
