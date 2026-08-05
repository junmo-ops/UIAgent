import { describe, expect, it } from 'vitest';
import { isWorkspacePreviewUrl, normalizeAgentServiceUrl } from './agent-service-url';

describe('agent service configuration', () => {
  it('normalizes a service root URL', () => {
    expect(normalizeAgentServiceUrl(' https://ui-agent.example.test/ ')).toBe('https://ui-agent.example.test');
  });

  it('only trusts workspace previews served by the configured service origin', () => {
    const preview = 'https://ui-agent.example.test/workspaces/11111111-1111-4111-8111-111111111111/preview';
    expect(isWorkspacePreviewUrl(preview, 'https://ui-agent.example.test')).toBe(true);
    expect(isWorkspacePreviewUrl(preview, 'https://other.example.test')).toBe(false);
    expect(isWorkspacePreviewUrl('https://ui-agent.example.test/not-a-workspace', 'https://ui-agent.example.test')).toBe(false);
  });
});
