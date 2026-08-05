import {
  SNAPSHOT_PACKAGE_FORMAT,
  SNAPSHOT_PACKAGE_VERSION,
  portableSnapshotPackageSchema,
  type PortableSnapshotPackage,
  type StaticSnapshot
} from '@ui-agent/contracts';

export const MAX_PORTABLE_SNAPSHOT_BYTES = 15_000_000;

export function createPortableSnapshotPackage(
  snapshot: StaticSnapshot,
  exportedAt = new Date().toISOString()
): PortableSnapshotPackage {
  return portableSnapshotPackageSchema.parse({
    format: SNAPSHOT_PACKAGE_FORMAT,
    version: SNAPSHOT_PACKAGE_VERSION,
    exportedAt,
    snapshot,
    safety: {
      activeContentRemoved: true,
      browserStateExcluded: ['cookies', 'localStorage', 'sessionStorage']
    }
  });
}

export function serializePortableSnapshotPackage(value: PortableSnapshotPackage): string {
  return JSON.stringify(portableSnapshotPackageSchema.parse(value), null, 2);
}

export function parsePortableSnapshotPackage(text: string): PortableSnapshotPackage {
  if (new Blob([text]).size > MAX_PORTABLE_SNAPSHOT_BYTES) {
    throw new Error('快照包超过 15 MB 限制');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON 快照包');
  }
  const parsed = portableSnapshotPackageSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('快照包格式或版本不受支持，请使用当前版本插件重新导出');
  }
  return parsed.data;
}

export function portableSnapshotFilename(title: string, capturedAt: string): string {
  const safeTitle = title
    .replace(/\s*·\s*静态快照\s*$/, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim()
    .slice(0, 60) || 'ui-page';
  const timestamp = capturedAt.replace(/[:.]/g, '-');
  return `${safeTitle}-${timestamp}.ui-snapshot.json`;
}
