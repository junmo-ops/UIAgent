import type { ReactNode } from 'react';

/** Shared geometry for routing, waiting and editing; an empty label keeps its slot. */
export function AgentWorkingStatus({ children }: { children?: ReactNode }) {
  return <div className="agent-working-status" role="status" aria-live="polite" aria-atomic="true">
    {children}
  </div>;
}

export function AgentThinkingPlaceholder() {
  return <section className="agent-activity" aria-label="本轮处理过程">
    <AgentWorkingStatus>正在思考…</AgentWorkingStatus>
  </section>;
}
