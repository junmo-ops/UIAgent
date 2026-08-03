import { describe, expect, it } from 'vitest';
import { isLocalWorkspacePreviewUrl, pageInjectionError, pageInjectionIssue } from './url-policy';

describe('pageInjectionError', () => {
  it('allows arbitrary HTTP and HTTPS pages', () => {
    expect(pageInjectionError('https://example.com/orders')).toBeUndefined();
    expect(pageInjectionError('http://127.0.0.1:5173')).toBeUndefined();
  });

  it('rejects browser-protected protocols with an actionable message', () => {
    expect(pageInjectionError('chrome://extensions')).toMatch(/不允许/);
    expect(pageInjectionError('chrome-extension://test/page.html')).toMatch(/不允许/);
    expect(pageInjectionIssue('chrome://extensions')?.code).toBe('UNSUPPORTED_PAGE');
    expect(pageInjectionIssue(undefined)?.code).toBe('INVALID_PAGE_URL');
  });

  it('only recognizes local static source workspace previews', () => {
    expect(isLocalWorkspacePreviewUrl(
      'http://127.0.0.1:8787/workspaces/11111111-1111-4111-8111-111111111111/preview'
    )).toBe(true);
    expect(isLocalWorkspacePreviewUrl(
      'http://localhost:9000/workspaces/11111111-1111-4111-8111-111111111111/preview?revision=2'
    )).toBe(true);
    expect(isLocalWorkspacePreviewUrl(
      'http://localhost:9000/workspaces/11111111-1111-4111-8111-111111111111/preview/'
    )).toBe(true);
    expect(isLocalWorkspacePreviewUrl(
      'https://example.com/workspaces/11111111-1111-4111-8111-111111111111/preview'
    )).toBe(false);
    expect(isLocalWorkspacePreviewUrl('chrome-extension://test/workspace-loading.html')).toBe(false);
  });
});
