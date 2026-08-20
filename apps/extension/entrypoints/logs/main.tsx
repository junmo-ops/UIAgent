import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { agentServiceFetch } from '../../src/service/agent-service-client';
import { getAgentServiceUrl } from '../../src/service/agent-service-config';
import './style.css';

interface LogEntry { id: string; instruction?: string; status?: string; timestamp?: string; durationMs?: number; [key: string]: any }

function LogsApp() {
  const [serviceUrl, setServiceUrl] = useState<string>();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<LogEntry>();
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const load = async () => { try { const url = serviceUrl ?? await getAgentServiceUrl(); setServiceUrl(url); const response = await agentServiceFetch(`${url}/v1/logs`); if (!response.ok) throw new Error(`读取日志失败（${response.status}）`); const payload = await response.json() as unknown; const entries = Array.isArray(payload) ? payload.filter(item => item && typeof item === 'object') as LogEntry[] : []; setLogs(entries); if (selectedId && !entries.some(item => item.id === selectedId)) { setSelectedId(''); setSelected(undefined); } } catch (cause) { setError(cause instanceof Error ? cause.message : '读取日志失败'); } };
  const show = async (id: string) => { try { const url = serviceUrl ?? await getAgentServiceUrl(); setServiceUrl(url); setSelectedId(id); const response = await agentServiceFetch(`${url}/v1/logs/${encodeURIComponent(id)}`); if (!response.ok) throw new Error(`读取日志详情失败（${response.status}）`); setSelected(await response.json() as LogEntry); } catch (cause) { setError(cause instanceof Error ? cause.message : '读取日志详情失败'); } };
  const copySelected = async () => { if (!selected) return; try { await navigator.clipboard.writeText(JSON.stringify(selected, null, 2)); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { setError('复制日志失败，请检查浏览器剪贴板权限'); } };
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer); }, []);
  const visible = useMemo(() => { const query = filter.toLowerCase(); return logs.filter(item => JSON.stringify(item).toLowerCase().includes(query)); }, [logs, filter]);
  return <><header><div><h1>UI Agent 会话日志</h1><div className="sub">本机调试数据 · 不包含 API Key</div></div><div style={{ display: 'flex', gap: 8 }}><button type="button" disabled={!selected} onClick={() => void copySelected()}>{copied ? '已复制' : '复制当前日志'}</button><button type="button" onClick={() => void load()}>刷新日志</button></div></header>{error && <div className="error-banner">{error}<button type="button" onClick={() => setError(undefined)}>×</button></div>}<div className="layout"><aside><div className="toolbar"><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选会话 ID、指令或状态" /><div className="sub">共 {visible.length} 条，最多保留 200 条</div></div><div>{visible.map(item => <button type="button" key={item.id} className={`entry ${item.id === selectedId ? 'active' : ''}`} onClick={() => void show(item.id)}><div className="entry-title">{item.instruction}</div><div className="meta"><span className={`status ${item.status}`}>{item.status}</span>{item.timestamp && new Date(item.timestamp).toLocaleString()}{item.durationMs != null && ` · ${item.durationMs}ms`}</div></button>)}</div></aside><main>{selected ? <Detail item={selected} /> : <div className="empty">选择一条日志查看请求详情</div>}</main></div></>;
}
function Detail({ item }: { item: LogEntry }) { const model = item.model ?? {}; const request = item.request ?? {}; return <><section className="card"><h2>基本信息</h2><div className="kv">{[['状态', item.status], ['模式', '静态源码副本'], ['模型', `${model.provider ?? ''} / ${model.name ?? model.mode ?? ''}`], ['会话 ID', request.editSessionId], ['Turn ID', request.turnId], ['Trace ID', request.traceId], ['耗时', item.durationMs == null ? '-' : `${item.durationMs} ms`]].map(([key, value]) => <React.Fragment key={String(key)}><div className="key">{key}</div><div>{String(value ?? '')}</div></React.Fragment>)}</div></section>{[['当前请求', item.request], ['此前对话', item.conversation], ['源码工具循环', item.sourceSteps ?? []], ['模型结果', item.result ?? item.error ?? null]].map(([title, value]) => <section className="card" key={String(title)}><h2>{title}</h2><pre>{JSON.stringify(value, null, 2)}</pre></section>)}</>; }
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><LogsApp /></React.StrictMode>);
