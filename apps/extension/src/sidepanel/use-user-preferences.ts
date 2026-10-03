import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { agentServiceFetch } from '../service/agent-service-client';

export interface UserPreferences { sendShortcut: 'enter' | 'modifier-enter'; expandProcess: boolean }
const defaults: UserPreferences = { sendShortcut: 'enter', expandProcess: false };
function decode(value: unknown): UserPreferences {
  const item = value as Partial<UserPreferences> | undefined;
  return { sendShortcut: item?.sendShortcut === 'modifier-enter' ? 'modifier-enter' : 'enter', expandProcess: item?.expandProcess === true };
}
export function useUserPreferences(serviceUrl: string, enabled: boolean) {
  const [value, setValue] = useState(defaults);
  const [identity, setIdentity] = useState<{ userId: string; tenantId?: string; displayName?: string; identityType?: string }>();
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let storageKey = '', revision = 0;
    setKey(''); setIdentity(undefined); setValue(defaults); setError('');
    const read = async () => {
      const current = ++revision;
      const result = await browser.storage.local.get(storageKey);
      if (!controller.signal.aborted && current === revision) setValue(decode(result[storageKey]));
    };
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && storageKey && changes[storageKey]) void read().catch(() => setError('偏好读取失败，请重试'));
    };
    browser.storage.onChanged.addListener(changed);
    void (async () => {
      const response = await agentServiceFetch(`${serviceUrl.replace(/\/$/, '')}/v1/auth/me`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error('账号与偏好读取失败');
      const user = await response.json();
      if (typeof user.userId !== 'string' || !user.userId) throw new Error('用户身份无效');
      if (controller.signal.aborted) return;
      storageKey = `user-preferences:${JSON.stringify([new URL(serviceUrl).origin, user.tenantId ?? '', user.userId])}`;
      await read();
      if (!controller.signal.aborted) { setIdentity(user); setKey(storageKey); }
    })().catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '偏好读取失败'); });
    return () => { controller.abort(); browser.storage.onChanged.removeListener(changed); };
  }, [serviceUrl, enabled, attempt]);
  const update = async (next: UserPreferences) => {
    if (!key || saving) return;
    setSaving(true); setError('');
    try { await browser.storage.local.set({ [key]: next }); setValue(next); }
    catch { setError('偏好保存失败，请重试'); }
    finally { setSaving(false); }
  };
  const reset = async () => {
    if (!key || !identity) throw new Error('偏好尚未加载');
    const modelKey = `model-choice:${JSON.stringify([serviceUrl.replace(/\/$/, ''), identity.tenantId ?? '', identity.userId])}`;
    setSaving(true);
    try {
      await browser.storage.local.remove([key, modelKey]);
      setValue(defaults); setError('');
    } finally { setSaving(false); }
  };
  return { value, identity, ready: Boolean(key) && enabled, error, saving, update, reset, retry: () => setAttempt(x => x + 1) };
}
