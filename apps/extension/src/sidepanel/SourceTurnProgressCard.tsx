import { lazy, Suspense, useEffect, useState } from 'react';
import type { SourceTurnTranscript } from '@ui-agent/contracts';

const MarkdownMessage = lazy(() => import('./MarkdownMessage').then(module => ({ default: module.MarkdownMessage })));
const skipLabels = {
  read_budget: '已达到读取额度',
  duplicate_read: '已有相同查询结果',
  finalization_budget: '已进入任务收尾阶段'
} as const;

function elapsed(start: string, end: number): string {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return '—';
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function SourceTurnProgressCard({ progress }: { progress: SourceTurnTranscript }) {
  const [now, setNow] = useState(Date.now);
  const active = progress.status === 'running' || progress.status === 'cancelling';
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, progress.turnId]);
  const timeline = progress.timeline ?? [];
  const hasProcess = timeline.length > 0;
  const duration = elapsed(progress.startedAt ?? progress.updatedAt, active ? now : Date.parse(progress.updatedAt));
  const content = <div className="agent-activity-content">
    {progress.timelineTruncated && <p className="agent-activity-status">仅显示最近的过程，完整技术记录可在日志中查看。</p>}
    {timeline.map(item => item.kind === 'commentary'
      ? <div key={item.id} className="agent-activity-narration">
          <Suspense fallback={<span>{item.text}</span>}><MarkdownMessage text={item.text} /></Suspense>
        </div>
      : <div key={item.id} className={`agent-activity-tool is-${item.status}`}>
          {item.status === 'failed' || item.status === 'blocked'
            ? <svg className="agent-activity-warning" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 2 15 14H1Z" /><path d="M8 6v4m0 2v.5" />
              </svg>
            : <span className={`agent-activity-dot${active && item.status === 'running' ? ' is-active' : ''}`} aria-hidden="true" />}
          <span>{item.status === 'running' ? active ? '正在' : '未确认完成：'
            : item.status === 'failed' ? '未成功：' : item.status === 'skipped' ? '已跳过：'
              : item.status === 'blocked' ? '未执行：' : '已完成：'}{item.text}
            {item.status === 'skipped' && item.skipReason ? `（${skipLabels[item.skipReason]}）` : ''}</span>
        </div>)}
  </div>;
  const uncertain = !active && (progress.status === 'failed' || progress.status === 'cancelled'
    || progress.saveState === 'draft' || progress.saveState === 'unconfirmed');
  const saveMessage = progress.saveState === 'saved' ? '已保存的修改仍保留。'
    : progress.saveState === 'unchanged' || progress.saveState === 'not_started' ? '本轮未保存新版本。'
      : progress.saveState === 'draft' ? '草稿尚未发布。' : '保存状态尚未确认，请检查当前副本。';
  return <section className="agent-activity" aria-label="本轮处理过程">
    {active ? <>
      {hasProcess && <><div className="agent-activity-heading">已处理 {duration}</div>{content}</>}
      <div className="agent-activity-status" role="status" aria-live="polite">
        {progress.status === 'cancelling' ? '正在停止…'
          : progress.execution === 'tool' && timeline.at(-1)?.status === 'running' ? null
            : progress.execution === 'model' && progress.message.includes('繁忙') ? '服务繁忙，等待重试…'
              : progress.saveState === 'draft' ? progress.message : '正在思考…'}
      </div>
    </> : hasProcess && <details className="agent-activity-disclosure">
      <summary>用时 {duration}<svg className="agent-activity-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></summary>
      {content}
    </details>}
    {uncertain && <p className="agent-activity-notice" role="status">
      {progress.status === 'cancelled' ? '已停止。' : progress.status === 'failed' ? '本轮未完成。' : ''}{saveMessage}
    </p>}
  </section>;
}
