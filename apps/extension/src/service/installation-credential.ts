import {
  installationCredentialSchema,
  type InstallationCredential
} from '@ui-agent/contracts';
import { storage } from 'wxt/utils/storage';

interface StoredInstallationCredential extends InstallationCredential {
  serviceOrigin: string;
}

const credentialsItem = storage.defineItem<Record<string, StoredInstallationCredential>>(
  'local:agentInstallationCredentials',
  { fallback: {} }
);

const pending = new Map<string, Promise<string | undefined>>();
const unsupportedOrigins = new Set<string>();
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

async function storeCredential(origin: string, credential: InstallationCredential): Promise<string> {
  const credentials = await credentialsItem.getValue();
  await credentialsItem.setValue({
    ...credentials,
    [origin]: { ...credential, serviceOrigin: origin }
  });
  return credential.accessToken;
}

async function requestCredential(
  origin: string,
  path: '/v1/auth/installations' | '/v1/auth/installations/refresh',
  accessToken?: string
): Promise<Response> {
  const headers = new Headers();
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers,
    credentials: 'include'
  });
}

async function resolveCredential(origin: string): Promise<string | undefined> {
  const credentials = await credentialsItem.getValue();
  const stored = credentials[origin];
  if (stored) {
    const remaining = Date.parse(stored.expiresAt) - Date.now();
    if (remaining > RENEW_BEFORE_MS) return stored.accessToken;
    if (remaining > 0) {
      const refreshed = await requestCredential(origin, '/v1/auth/installations/refresh', stored.accessToken);
      if (refreshed.ok) {
        return storeCredential(origin, installationCredentialSchema.parse(await refreshed.json()));
      }
      // Keep a still-valid credential when a transient deployment does not expose refresh.
      if (refreshed.status !== 401) return stored.accessToken;
    }
    throw new Error('插件安装身份已失效。请联系试点管理员恢复身份，避免创建新的空白身份。');
  }

  const issued = await requestCredential(origin, '/v1/auth/installations');
  // Development mode and future external-login deployments may not use installation auth.
  if (issued.status === 404) {
    unsupportedOrigins.add(origin);
    return undefined;
  }
  if (!issued.ok) throw new Error('无法领取插件安装身份，请检查 Agent Service 身份配置。');
  return storeCredential(origin, installationCredentialSchema.parse(await issued.json()));
}

export function getInstallationAccessToken(requestUrl: string): Promise<string | undefined> {
  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return Promise.resolve(undefined);
  }
  if (unsupportedOrigins.has(origin)) return Promise.resolve(undefined);
  const existing = pending.get(origin);
  if (existing) return existing;
  const task = resolveCredential(origin).finally(() => pending.delete(origin));
  pending.set(origin, task);
  return task;
}
