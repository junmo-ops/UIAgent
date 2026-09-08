import { useEffect, useState } from 'react';
import type { SourceTurnProgress } from '@ui-agent/contracts';
import './agent-debug-details.css';

export function AgentDebugDetails({ progress }: { progress: SourceTurnProgress }) {
  const [now, setNow] = useState(Date.now());
  const running = progress.status === 'running' || progress.status === 'cancelling';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!progress.modelDetails?.length) return null;
  return <details className="agent-debug-details">
    <summary>开发调试详情 · {progress.modelDetails.length} 轮调用</summary>
    <p>用量由模型接口返回；未提供的指标显示“未返回”。调用耗时包含该轮工具执行。</p>
    {progress.modelDetails.map(call => {
      const ms = call.durationMs ?? Math.max(0, (running ? now : Date.parse(progress.updatedAt)) - Date.parse(call.startedAt));
      return <details key={call.modelCall}>
        <summary>第 {call.modelCall} 轮 · {call.status === 'running' ? (running ? '进行中' : '已结束，未返回统计') : call.status === 'failed' ? '失败' : '完成'} · {(ms / 1000).toFixed(1)} 秒</summary>
        <p>输入 {call.usage?.inputTokens ?? '未返回'} · 输出 {call.usage?.outputTokens ?? '未返回'} · 推理 {call.usage?.reasoningTokens ?? '未返回'} token</p>
        {call.tools?.map((tool, index) => <p key={index}>{tool.name} · {tool.status} · {tool.durationMs ?? '未返回'} ms</p>)}
        <details>
          <summary>接口返回的推理内容{call.reasoningTruncated ? '（已截断）' : ''}</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto', fontSize: 12 }}>{call.reasoning || '接口未返回推理文本。'}</pre>
        </details>
      </details>;
    })}
  </details>;
}
