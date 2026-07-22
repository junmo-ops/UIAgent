import { describe, expect, it } from 'vitest';
import { pageInjectionError, pageInjectionIssue } from './url-policy';

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
});
