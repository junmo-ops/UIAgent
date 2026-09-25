import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { agentServiceFetch } from '../service/agent-service-client';

/** Per installation identity and service; never a shared service-wide setting. */
export function useSkillPreferences(serviceUrl: string, enabled: boolean) {
  const [disabledIds, setDisabledIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const prefixRef = useRef('');
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let revision = 0;
    setReady(false);
    setError('');
    prefixRef.current = '';
    const read = async (prefix: string) => {
      const current = ++revision;
      const values = await browser.storage.local.get(null);
      if (!controller.signal.aborted && current === revision) {
        setDisabledIds(Object.keys(values).filter(key => key.startsWith(prefix) && values[key] === false).map(key => key.slice(prefix.length)));
        setReady(true);
      }
    };
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && prefixRef.current && Object.keys(changes).some(key => key.startsWith(prefixRef.current))) void read(prefixRef.current).catch(() => {
        if (!controller.signal.aborted) { setReady(false); setError('技能设置读取失败，请重试。'); }
      });
    };
    browser.storage.onChanged.addListener(changed);
    void (async () => {
      const response = await agentServiceFetch(`${serviceUrl.replace(/\/$/, '')}/v1/auth/me`, { signal: controller.signal });
      if (!response.ok) throw new Error('identity unavailable');
      const identity = await response.json();
      if (typeof identity.userId !== 'string' || !identity.userId) throw new Error('invalid identity');
      if (controller.signal.aborted) return;
      const prefix = `skill-enabled:${encodeURIComponent(JSON.stringify([new URL(serviceUrl).origin, identity.tenantId ?? '', identity.userId]))}:`;
      prefixRef.current = prefix;
      await read(prefix);
    })().catch(() => { if (!controller.signal.aborted) setError('技能设置读取失败，请重试。'); });
    return () => { controller.abort(); prefixRef.current = ''; browser.storage.onChanged.removeListener(changed); };
  }, [serviceUrl, enabled, retry]);
  const toggle = async (id: string, checked: boolean) => {
    if (!ready || saving || !prefixRef.current) return;
    const prefix = prefixRef.current;
    setSaving(true);
    setError('');
    try {
      await browser.storage.local.set({ [`${prefix}${id}`]: checked });
      if (prefixRef.current === prefix) setDisabledIds(ids => checked ? ids.filter(value => value !== id) : [...new Set([...ids, id])]);
    } catch { setError('技能设置保存失败，请重试。'); }
    finally { setSaving(false); }
  };
  return { disabledIds, ready, saving, error, toggle, retry: () => setRetry(value => value + 1) };
}
