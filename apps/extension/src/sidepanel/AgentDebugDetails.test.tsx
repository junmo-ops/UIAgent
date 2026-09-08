import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentDebugDetails } from './AgentDebugDetails';

describe('AgentDebugDetails', () => {
  it('keeps reasoning collapsed and escapes provider content while distinguishing missing usage', () => {
    const html = renderToStaticMarkup(<AgentDebugDetails progress={{
      workspaceId: '11111111-1111-4111-8111-111111111111', turnId: 'turn', status: 'completed',
      phase: 'finishing', message: '完成', modelCalls: 1, toolCalls: 0, updatedAt: new Date().toISOString(), activities: [],
      modelDetails: [{ modelCall: 1, startedAt: new Date().toISOString(), status: 'completed', durationMs: 1500,
        reasoning: '<script>test</script>', usage: { outputTokens: 0 } }]
    }} />);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(' open');
    expect(html).toContain('推理 未返回');
    expect(html).toContain('输出 0');
    expect(html).toContain('1.5 秒');
  });
});
