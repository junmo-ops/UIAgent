import { useState } from 'react';
import { Alert, Button, Input, Switch } from 'antd';

export function SkillIcon() {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /></svg>;
}

export function SkillPanel({ skills, loading, error, disabledIds, saving, onToggle, onClose, onRetry }: {
  skills: Array<{ id: string; displayName?: string; description: string; scripts: Array<{ available: boolean }> }>;
  loading: boolean; error: string; disabledIds: string[]; saving: boolean;
  onToggle: (id: string, checked: boolean) => void; onClose: () => void; onRetry: () => void;
}) {
  const [search, setSearch] = useState('');
  const visible = skills.filter(skill => `${skill.displayName ?? skill.id} ${skill.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="history-panel" aria-label="技能" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <header className="history-header"><h1>技能 <span>({skills.length})</span></h1>
      <button className="history-icon-button" type="button" aria-label="关闭技能面板" onClick={onClose}><svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>
    <Input className="history-search" autoFocus allowClear aria-label="搜索技能" placeholder="搜索技能" value={search} onChange={event => setSearch(event.target.value)} />
    <p className="history-hint">助手按需使用已开启的技能。更改从下一轮生效。</p>
    {error && <Alert type="error" message={error} action={<Button size="small" onClick={onRetry}>重试</Button>} />}
    <div className="conversation-list" aria-busy={loading}>
      {loading ? <p className="history-empty" role="status">正在加载…</p> : <>
        {!visible.length && <p className="history-empty">{search.trim() ? '没有找到匹配的技能' : '暂无可用技能'}</p>}
        {visible.map(skill => <div className="skill-setting-row" key={skill.id}>
          <div className="skill-setting-copy"><strong>{skill.displayName ?? skill.id}</strong><p>{skill.description}</p>
            {skill.scripts.some(script => !script.available) && <small>部分脚本运行环境不可用</small>}
          </div>
          <Switch checked={!disabledIds.includes(skill.id)} checkedChildren="开" unCheckedChildren="关" disabled={saving || Boolean(error)} aria-label={`启用${skill.displayName ?? skill.id}`} onChange={checked => onToggle(skill.id, checked)} />
        </div>)}
      </>}
    </div>
  </section>;
}
