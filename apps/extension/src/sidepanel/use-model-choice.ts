import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { modelCatalogSchema } from '@ui-agent/contracts';
import { agentServiceFetch } from '../service/agent-service-client';

export function useModelChoice(serviceUrl: string, enabled: boolean) {
  const [models, setModels] = useState<Array<{ id: string; label: string; name: string; available: boolean }>>([]);
  const [id, setId] = useState('default');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const keyRef = useRef('');
  useEffect(() => {
    setReady(false); setError(''); keyRef.current = '';
    if (!enabled) return;
    const controller = new AbortController();
    let defaultId = 'default';
    const changed = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      const change = changes[keyRef.current];
      if (area === 'local' && change) setId(typeof change.newValue === 'string' ? change.newValue : defaultId);
    };
    browser.storage.onChanged.addListener(changed);
    void (async () => {
      const base = serviceUrl.replace(/\/$/, '');
      const [response, identityResponse] = await Promise.all([
        agentServiceFetch(`${base}/v1/models`, { signal: controller.signal }),
        agentServiceFetch(`${base}/v1/auth/me`, { signal: controller.signal })
      ]);
      if (!response.ok || !identityResponse.ok) throw new Error('模型列表加载失败，请重试');
      const catalog = modelCatalogSchema.parse(await response.json());
      defaultId = catalog.defaultId;
      const identity = await identityResponse.json();
      if (typeof identity.userId !== 'string' || !identity.userId) throw new Error('用户身份读取失败');
      const key = `model-choice:${JSON.stringify([base, identity.tenantId ?? '', identity.userId])}`;
      const stored = (await browser.storage.local.get(key))[key];
      if (controller.signal.aborted) return;
      keyRef.current = key;
      const choice = typeof stored === 'string' ? stored : catalog.defaultId;
      setId(choice);
      setModels(catalog.models.some(model => model.id === choice) ? catalog.models :
        [...catalog.models, { id: choice, label: '原模型已移除，请重新选择', name: '', available: false }]);
      setReady(true);
    })().catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '模型列表加载失败'); });
    return () => { controller.abort(); keyRef.current = ''; browser.storage.onChanged.removeListener(changed); };
  }, [serviceUrl, enabled, attempt]);
  const choose = async (value: string) => {
    if (!ready || saving || !keyRef.current || !models.some(model => model.id === value && model.available)) return;
    const key = keyRef.current;
    setSaving(true); setError('');
    try {
      await browser.storage.local.set({ [key]: value });
      if (key === keyRef.current) setId(value);
    } catch { if (key === keyRef.current) setError('模型选择保存失败，请重试'); }
    finally { setSaving(false); }
  };
  return { models, id, ready: ready && enabled, saving, error, choose,
    available: ready && enabled && !saving && models.some(model => model.id === id && model.available),
    retry: () => setAttempt(value => value + 1) };
}
