import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  portableSnapshotPackageSchema,
  workspaceArchiveManifestSchema,
  workspaceArchiveSchema,
  WORKSPACE_ARCHIVE_FORMAT,
  WORKSPACE_ARCHIVE_VERSION,
  type WorkspaceArchive,
  type WorkspaceArchiveManifest
} from '@ui-agent/contracts';

const MANIFEST_PATH = 'manifest.json';

function safeTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|\r\n]+/g, '-').trim().slice(0, 80) || 'workspace';
}

export function serializeWorkspaceArchiveZip(archive: WorkspaceArchive): Uint8Array {
  const parsed = workspaceArchiveSchema.parse(archive);
  const entries = parsed.workspaces.map((portable, index) => ({
    path: `workspaces/${String(index + 1).padStart(3, '0')}-${safeTitle(portable.snapshot.title)}/snapshot.json`,
    title: portable.snapshot.title,
    sourceUrl: portable.snapshot.sourceUrl
  }));
  const manifest: WorkspaceArchiveManifest = workspaceArchiveManifestSchema.parse({
    format: WORKSPACE_ARCHIVE_FORMAT,
    version: WORKSPACE_ARCHIVE_VERSION,
    exportedAt: parsed.exportedAt,
    workspaces: entries
  });
  const files: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: strToU8(JSON.stringify(manifest, null, 2))
  };
  parsed.workspaces.forEach((portable, index) => {
    files[entries[index]!.path] = strToU8(JSON.stringify(portable, null, 2));
  });
  return zipSync(files, { level: 6 });
}

export function parseWorkspaceArchiveZip(bytes: Uint8Array): WorkspaceArchive {
  const files = unzipSync(bytes);
  const manifestBytes = files[MANIFEST_PATH];
  if (!manifestBytes) throw new Error('ZIP 备份包缺少 manifest.json');
  const manifest = workspaceArchiveManifestSchema.safeParse(JSON.parse(strFromU8(manifestBytes)));
  if (!manifest.success) throw new Error('ZIP 备份包的 manifest.json 格式不受支持');
  const packages = manifest.data.workspaces.map(entry => {
    const content = files[entry.path];
    if (!content) throw new Error(`ZIP 备份包缺少副本文件：${entry.path}`);
    const parsed = portableSnapshotPackageSchema.safeParse(JSON.parse(strFromU8(content)));
    if (!parsed.success) throw new Error(`ZIP 备份包中的副本格式无效：${entry.title}`);
    return parsed.data;
  });
  return workspaceArchiveSchema.parse({
    format: manifest.data.format,
    version: manifest.data.version,
    exportedAt: manifest.data.exportedAt,
    workspaces: packages
  });
}
