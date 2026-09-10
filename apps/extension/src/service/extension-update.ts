export interface ExtensionUpdateInfo {
  version: string;
  downloadUrl: string;
  releaseNotes?: string;
  publishedAt?: string;
}

const VERSION_PATTERN = /^\d+(?:\.\d+){0,3}$/;

function parseVersion(value: string): number[] | undefined {
  if (!VERSION_PATTERN.test(value)) return undefined;
  return value.split('.').map(Number);
}

export function isNewerExtensionVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  const length = Math.max(next.length, installed.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (next[index] ?? 0) - (installed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function isUpdateInfo(value: unknown): value is ExtensionUpdateInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.version !== 'string' || !VERSION_PATTERN.test(candidate.version)) return false;
  if (typeof candidate.downloadUrl !== 'string') return false;
  try {
    const url = new URL(candidate.downloadUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
  } catch {
    return false;
  }
  return (candidate.releaseNotes === undefined || typeof candidate.releaseNotes === 'string')
    && (candidate.publishedAt === undefined || typeof candidate.publishedAt === 'string');
}

export async function fetchAvailableExtensionUpdate(serviceUrl: string): Promise<ExtensionUpdateInfo | undefined> {
  const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/v1/extension/latest`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status === 204) return undefined;
  if (!response.ok) throw new Error(`检查插件更新失败（HTTP ${response.status}）`);
  const update = await response.json() as unknown;
  if (!isUpdateInfo(update)) throw new Error('插件更新信息格式不正确');
  if (!isNewerExtensionVersion(update.version, browser.runtime.getManifest().version)) return undefined;
  return update;
}
