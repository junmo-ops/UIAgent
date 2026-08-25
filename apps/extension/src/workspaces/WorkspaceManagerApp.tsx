import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  portableSnapshotPackageSchema,
  sourceWorkspaceCreatedSchema,
  workspaceArchiveSchema,
  workspaceListResponseSchema,
  type ManagedWorkspace,
  type WorkspaceListResponse
} from '@ui-agent/contracts';
import { getAgentServiceUrl } from '../service/agent-service-config';
import { agentServiceFetch } from '../service/agent-service-client';
import { parseWorkspaceArchiveZip, serializeWorkspaceArchiveZip } from './workspace-archive';

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
  const [notice, setNotice] = useState<string>();
  const [renaming, setRenaming] = useState<ManagedWorkspace>();
  const [draftTitle, setDraftTitle] = useState('');
  const [transferBusy, setTransferBusy] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

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

  const exportAllWorkspaces = async () => {
    setTransferBusy(true);
    try {
      const response = await agentServiceFetch(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces/export-all`, { cache: 'no-store' });
      if (!response.ok) throw await responseError(response, '一键导出失败');
      const archive = workspaceArchiveSchema.parse(await response.json());
      const zipBytes = serializeWorkspaceArchiveZip(archive);
      const zipBuffer = new ArrayBuffer(zipBytes.byteLength);
      new Uint8Array(zipBuffer).set(zipBytes);
      const blob = new Blob([zipBuffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      try {
        await browser.downloads.download({
          url,
          filename: `ui-agent-workspace-backup-${archive.exportedAt.replace(/[:.]/g, '-')}.zip`,
          saveAs: true
        });
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
      }
      setNotice(`已导出 ${archive.workspaces.length} 个副本，未包含回收站。`);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '一键导出失败');
    } finally {
      setTransferBusy(false);
    }
  };

  const importWorkspace = async (file: File) => {
    setTransferBusy(true);
    try {
      const raw = file.name.toLowerCase().endsWith('.zip')
        ? parseWorkspaceArchiveZip(new Uint8Array(await file.arrayBuffer()))
        : JSON.parse(await file.text());
      const archive = workspaceArchiveSchema.safeParse(raw);
      const packages = archive.success
        ? archive.data.workspaces
        : [portableSnapshotPackageSchema.parse(raw)];
      let importedCount = 0;
      const failures: string[] = [];
      // The service lists workspaces by updatedAt descending. Import in the
      // opposite order so newly-created timestamps restore that same order.
      for (const portable of [...packages].reverse()) {
        try {
          const response = await agentServiceFetch(`${serviceUrl.replace(/\/$/, '')}/v1/workspaces`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(portable.snapshot)
          });
          if (!response.ok) throw await responseError(response, '副本导入失败');
          sourceWorkspaceCreatedSchema.parse(await response.json());
          importedCount += 1;
        } catch (cause) {
          failures.push(cause instanceof Error ? cause.message : '副本导入失败');
        }
      }
      if (!importedCount) throw new Error(failures.at(0) ?? '副本导入失败');
      await load();
      setNotice(failures.length
        ? `已导入 ${importedCount} 个副本；${failures.length} 个未导入。`
        : `已导入 ${importedCount} 个副本。`);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '副本导入失败，请选择当前版本导出的快照包');
    } finally {
      setTransferBusy(false);
      if (importFileRef.current) importFileRef.current.value = '';
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
        {status === 'active' && <div className="workspace-transfer-actions">
          <button disabled={transferBusy || loading || !data?.total} onClick={() => void exportAllWorkspaces()}>导出全部</button>
          <button disabled={transferBusy || loading} onClick={() => importFileRef.current?.click()}>导入备份</button>
          <input ref={importFileRef} hidden type="file" accept=".zip,.json,application/zip,application/json" onChange={event => {
            const file = event.target.files?.[0];
            if (file) void importWorkspace(file);
          }} />
        </div>}
      </section>

      {error && <div className="manager-error"><span>{error}</span><button onClick={() => void load()}>重试</button></div>}
      {notice && <div className="manager-notice"><span>{notice}</span><button onClick={() => setNotice(undefined)}>关闭</button></div>}

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
                <button disabled={transferBusy} onClick={() => { setRenaming(workspace); setDraftTitle(workspace.title); }}>重命名</button>
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
