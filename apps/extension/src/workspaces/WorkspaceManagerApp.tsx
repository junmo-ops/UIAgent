import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  workspaceListResponseSchema,
  type ManagedWorkspace,
  type WorkspaceListResponse
} from '@ui-agent/contracts';
import { getAgentServiceUrl } from '../service/agent-service-config';
import { agentServiceFetch } from '../service/agent-service-client';

type WorkspaceStatus = 'active' | 'trashed';
const PAGE_SIZE = 18;

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
}

function sourceLabel(sourceUrl: string): string {
  try { return new URL(sourceUrl).hostname || '本地页面'; }
  catch { return sourceUrl || '未知来源'; }
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { message?: unknown };
    return new Error(typeof body.message === 'string' ? body.message : fallback);
  } catch {
    return new Error(fallback);
  }
}

export function WorkspaceManagerApp() {
  const [serviceUrl, setServiceUrl] = useState('');
  const [status, setStatus] = useState<WorkspaceStatus>('active');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<WorkspaceListResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [renaming, setRenaming] = useState<ManagedWorkspace>();
  const [draftTitle, setDraftTitle] = useState('');

  useEffect(() => { void getAgentServiceUrl().then(setServiceUrl); }, []);

  const load = useCallback(async () => {
    if (!serviceUrl) return;
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({
        status,
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE)
      });
      if (query.trim()) params.set('query', query.trim());
      const response = await agentServiceFetch(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces?${params}`, { cache: 'no-store' });
      if (!response.ok) throw await responseError(response, '副本列表加载失败');
      const nextData = workspaceListResponseSchema.parse(await response.json());
      if (page > 0 && page * PAGE_SIZE >= nextData.total) {
        setPage(value => Math.max(0, value - 1));
        return;
      }
      setData(nextData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '副本列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, query, serviceUrl, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  const mutate = async (path: string, init: RequestInit) => {
    const response = await agentServiceFetch(`${serviceUrl.replace(/\/$/, '')}${path}`, init);
    if (!response.ok) throw await responseError(response, '副本操作失败');
    await load();
  };

  const saveTitle = async () => {
    if (!renaming || !draftTitle.trim()) return;
    try {
      await mutate(`/v1/workspaces/${renaming.workspaceId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: draftTitle.trim() })
      });
      setRenaming(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名失败');
    }
  };

  const visibleCount = data?.items.length ?? 0;
  const emptyCopy = useMemo(() => query.trim()
    ? '没有找到匹配的副本，换个标题或来源地址试试。'
    : status === 'active'
      ? '还没有可管理的副本。回到任意页面，从插件创建第一个静态副本。'
      : '回收站是空的。删除的副本会暂存在这里。', [query, status]);

  return (
    <main className="manager-shell">
      <header className="manager-header">
        <div>
          <span className="eyebrow">UI AGENT · WORKSPACE ARCHIVE</span>
          <h1>副本管理</h1>
          <p>找到、继续或整理每一次页面探索。</p>
        </div>
        <div className="archive-count"><strong>{data?.total ?? 0}</strong><span>{status === 'active' ? '可用副本' : '回收站'}</span></div>
      </header>

      <section className="manager-controls" aria-label="筛选副本">
        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="搜索标题或来源地址" />
        </label>
        <div className="status-switch">
          <button className={status === 'active' ? 'active' : ''} onClick={() => { setStatus('active'); setPage(0); }}>全部副本</button>
          <button className={status === 'trashed' ? 'active' : ''} onClick={() => { setStatus('trashed'); setPage(0); }}>回收站</button>
        </div>
      </section>

      {error && <div className="manager-error"><span>{error}</span><button onClick={() => void load()}>重试</button></div>}

      <section className={`workspace-grid ${loading ? 'loading' : ''}`} aria-busy={loading}>
        {!loading && visibleCount === 0 && <div className="empty-archive"><i>∅</i><strong>这里暂时没有记录</strong><p>{emptyCopy}</p></div>}
        {data?.items.map(workspace => (
          <article className="workspace-card" key={workspace.workspaceId}>
            <div className="workspace-card-top">
              <span className="source-host">{sourceLabel(workspace.sourceUrl)}</span>
              <span className="revision-mark">R{workspace.revision}</span>
            </div>
            <h2>{workspace.title}</h2>
            <p className="source-url" title={workspace.sourceUrl}>{workspace.sourceUrl || '本地页面'}</p>
            <div className="revision-line"><i /><span>最近修改 {formatTime(workspace.updatedAt)}</span></div>
            <div className="workspace-actions">
              {status === 'active' ? <>
                <button className="primary" onClick={() => void browser.tabs.create({ url: workspace.previewUrl })}>打开副本</button>
                <button onClick={() => { setRenaming(workspace); setDraftTitle(workspace.title); }}>重命名</button>
                <button className="danger" onClick={() => {
                  if (window.confirm(`将“${workspace.title}”移入回收站？`)) {
                    void mutate(`/v1/workspaces/${workspace.workspaceId}`, { method: 'DELETE' }).catch(cause => setError(cause instanceof Error ? cause.message : '删除失败'));
                  }
                }}>删除</button>
              </> : <>
                <button className="primary" onClick={() => void mutate(`/v1/workspaces/${workspace.workspaceId}/restore`, { method: 'POST' }).catch(cause => setError(cause instanceof Error ? cause.message : '恢复失败'))}>恢复副本</button>
              </>}
            </div>
          </article>
        ))}
      </section>

      {(data?.total ?? 0) > PAGE_SIZE && <nav className="pagination" aria-label="副本分页">
        <button disabled={page === 0 || loading} onClick={() => setPage(value => Math.max(0, value - 1))}>上一页</button>
        <span>{page + 1} / {Math.ceil((data?.total ?? 0) / PAGE_SIZE)}</span>
        <button disabled={(page + 1) * PAGE_SIZE >= (data?.total ?? 0) || loading} onClick={() => setPage(value => value + 1)}>下一页</button>
      </nav>}

      {renaming && <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setRenaming(undefined); }}>
        <section className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title">
          <span className="eyebrow">RENAME WORKSPACE</span>
          <h2 id="rename-title">给副本一个更容易找到的名字</h2>
          <input autoFocus maxLength={200} value={draftTitle} onChange={event => setDraftTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveTitle(); }} />
          <div><button onClick={() => setRenaming(undefined)}>取消</button><button className="primary" disabled={!draftTitle.trim()} onClick={() => void saveTitle()}>保存名称</button></div>
        </section>
      </div>}
    </main>
  );
}
