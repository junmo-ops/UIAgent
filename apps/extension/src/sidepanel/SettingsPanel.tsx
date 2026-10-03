import { useState } from 'react';
import { Alert, Button, Modal, Select, Switch } from 'antd';
import { browser } from 'wxt/browser';
import { useAccountActions } from './AuthGate';
import { agentServiceFetch } from '../service/agent-service-client';
import { fetchAvailableExtensionUpdate, type ExtensionUpdateInfo } from '../service/extension-update';
import type { useUserPreferences } from './use-user-preferences';
import type { useModelChoice } from './use-model-choice';

export function SettingsPanel({ serviceUrl, preferences, model, busy, isAdmin, onCopyId, onLogs, onUpdate, onClose }: {
  serviceUrl: string; preferences: ReturnType<typeof useUserPreferences>; model: ReturnType<typeof useModelChoice>;
  busy: boolean; isAdmin: boolean; onCopyId: () => void; onLogs: () => void;
  onUpdate: (update: ExtensionUpdateInfo) => void; onClose: () => void;
}) {
  const account = useAccountActions();
  const [checking, setChecking] = useState<'connection' | 'update'>();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const check = async (kind: 'connection' | 'update') => {
    setChecking(kind); setError(''); setStatus('');
    try {
      if (kind === 'connection') {
        const response = await agentServiceFetch(`${serviceUrl.replace(/\/$/, '')}/v1/auth/me`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`服务连接检查失败（HTTP ${response.status}）`);
        setStatus('服务连接正常，当前身份有效');
      } else {
        const update = await fetchAvailableExtensionUpdate(serviceUrl);
        if (update) { onUpdate(update); setStatus(`发现新版本 ${update.version}`); }
        else setStatus('当前服务未提供更新版本');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '检查失败，请重试'); }
    finally { setChecking(undefined); }
  };
  return <section className="settings-panel" aria-label="设置" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
  }}>
    <header className="history-header"><h1>设置</h1><Button autoFocus type="text" onClick={onClose}>返回对话</Button></header>
    <div className="settings-scroll">
      <section className="settings-group"><h2>账号</h2>
        <strong>{account?.displayName || preferences.identity?.displayName || (account ? '已登录' : '当前用户')}</strong>
        <p className="settings-user-id">{preferences.identity?.userId || (preferences.error ? '账号读取失败，请在下方重试' : '正在读取账号…')}</p>
        <p>{account ? '行内账号已登录' : preferences.identity ? preferences.identity.identityType === 'development' ? '开发身份，无需登录' : '安装身份，无需登录' : '正在确认身份'}</p>
        <div className="settings-actions"><Button disabled={!preferences.identity} onClick={onCopyId}>复制用户 ID</Button>
          {account && <><Button disabled={busy || account.busy} onClick={account.bindLegacy}>关联旧副本</Button>
            <Button disabled={busy || account.busy} onClick={() => Modal.confirm({ title: '退出当前账号？', content: '已保存的副本和历史对话会保留。', okText: '退出登录', cancelText: '取消', onOk: account.logout })}>退出登录</Button></>}
        </div>
      </section>
      <section className="settings-group"><h2>模型</h2>
        <label className="settings-label" htmlFor="settings-model">使用模型</label>
        <Select id="settings-model" className="settings-select" value={model.ready ? model.id : undefined} placeholder="正在读取模型…"
          disabled={busy || !model.ready || model.saving || preferences.saving} onChange={value => void model.choose(value)}
          options={model.models.map(item => ({ value: item.id, label: `${item.label}${item.available ? '' : '（未就绪）'}`, disabled: !item.available }))}/>
        <p>与对话中的模型选择同步，从下一轮发送生效。</p>
        {model.error && <Alert type="error" message={model.error} action={<Button onClick={model.retry}>重试</Button>}/>}
      </section>
      <section className="settings-group"><h2>对话偏好</h2>
        {preferences.error && <Alert type="error" message={preferences.error} action={<Button onClick={preferences.retry}>重试</Button>}/>}
        <label className="settings-label" htmlFor="settings-shortcut">发送快捷键</label>
        <Select id="settings-shortcut" className="settings-select" value={preferences.value.sendShortcut} disabled={!preferences.ready || preferences.saving}
          options={[{ value: 'enter', label: 'Enter 发送' }, { value: 'modifier-enter', label: 'Ctrl / ⌘ + Enter 发送' }]}
          onChange={sendShortcut => void preferences.update({ ...preferences.value, sendShortcut })}/>
        <p>{preferences.value.sendShortcut === 'enter' ? 'Shift + Enter 换行。' : 'Enter 换行，Ctrl 或 Command + Enter 发送。'}</p>
        <div className="settings-row"><span>默认展开已完成的执行过程</span><Switch aria-label="默认展开已完成的执行过程" checked={preferences.value.expandProcess}
          disabled={!preferences.ready || preferences.saving} onChange={expandProcess => void preferences.update({ ...preferences.value, expandProcess })}/></div>
        <p>执行中的进度继续实时展示。</p>
      </section>
      <section className="settings-group"><h2>关于与诊断</h2>
        <div className="settings-row"><span>插件版本</span><strong>{browser.runtime.getManifest().version}</strong></div>
        <p className="settings-service">当前服务：{serviceUrl}</p>
        <div className="settings-actions"><Button loading={checking === 'connection'} disabled={Boolean(checking)} onClick={() => void check('connection')}>检查连接</Button>
          <Button loading={checking === 'update'} disabled={Boolean(checking)} onClick={() => void check('update')}>检查更新</Button>
          {isAdmin && <Button onClick={onLogs}>运行日志</Button>}
        </div>
        {status && <p role="status">{status}</p>}{error && <Alert type="error" message={error}/>}
      </section>
      <section className="settings-group"><h2>恢复偏好</h2><p>恢复当前用户的模型选择和对话偏好。身份、副本、历史对话和草稿不受影响。</p>
        <Button disabled={busy || !preferences.ready || preferences.saving || model.saving} onClick={() => Modal.confirm({
          title: '恢复默认设置？', content: '仅恢复当前用户在当前服务下的个人偏好。', okText: '恢复默认', cancelText: '取消',
          onOk: async () => { try { await preferences.reset(); setError(''); setStatus('个人偏好已恢复默认'); } catch { setError('恢复失败，请重试'); throw new Error('恢复失败'); } }
        })}>恢复默认设置</Button>
      </section>
    </div>
  </section>;
}
