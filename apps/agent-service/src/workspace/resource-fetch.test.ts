import { EventEmitter } from 'node:events';
import { constants } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { fetchWorkspaceResource, resourceErrorCode } from './resource-fetch';

const legacyError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('TLS'), { code: 'ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED' }) });
beforeEach(() => { mocks.request.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
function nativeResponse(status = 200) {
  mocks.request.mockImplementation((_url, options, callback) => {
    expect(options).toMatchObject({ agent: false, rejectUnauthorized: true, secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT });
    const req = new EventEmitter() as any;
    req.destroy = (error: Error) => { req.emit('error', error); req.emit('close'); };
    req.end = () => {
      const res = new EventEmitter() as any;
      res.statusCode = status;
      res.headers = { 'content-type': 'image/svg+xml' };
      res.destroy = () => {};
      callback(res);
      if (status === 200) { res.emit('data', Buffer.from('<svg/>')); res.emit('end'); }
      req.emit('close');
    };
    return req;
  });
}
it('uses strict fetch first and preserves normal SVG responses', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<svg/>')));
  expect(await (await fetchWorkspaceResource('https://assets.example/icon.svg')).text()).toBe('<svg/>');
  expect(mocks.request).not.toHaveBeenCalled();
});
it.each(['assets.example', 'other.example'])('retries legacy TLS without host configuration for %s, retaining certificate verification', async host => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(legacyError()));
  nativeResponse();
  const response = await fetchWorkspaceResource(`https://${host}/icon.svg`);
  expect(await response.text()).toBe('<svg/>');
  expect(response.headers.get('content-type')).toBe('image/svg+xml');
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
it.each(['http://assets.example/icon.svg', 'https://user:password@assets.example/icon.svg'])('does not retry unsupported URLs: %s', async url => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(legacyError()));
  await expect(fetchWorkspaceResource(url)).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
});
it('does not retry certificate or network errors', async () => {
  const error = new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
  await expect(fetchWorkspaceResource('https://assets.example/icon.svg')).rejects.toBe(error);
  expect(resourceErrorCode(error)).toBe('CERT_HAS_EXPIRED');
  expect(mocks.request).not.toHaveBeenCalled();
});
it('rejects redirects without a location from the compatible resource connection', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(legacyError()));
  nativeResponse(302);
  await expect(fetchWorkspaceResource('https://assets.example/icon.svg')).rejects.toMatchObject({ code: 'RESOURCE_REDIRECT_INVALID' });
});

it('follows relative and cross-host redirects without forwarding credentials', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
    .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'https://cdn.example/icon.svg' } }))
    .mockResolvedValueOnce(new Response('<svg/>'));
  vi.stubGlobal('fetch', fetchMock);
  expect(await (await fetchWorkspaceResource('https://assets.example/icon.svg')).text()).toBe('<svg/>');
  expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(['https://assets.example/icon.svg', 'https://assets.example/next', 'https://cdn.example/icon.svg']);
  for (const call of fetchMock.mock.calls) expect(call[1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
});
it('bounds redirect loops', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/loop' } })));
  await expect(fetchWorkspaceResource('https://assets.example/loop')).rejects.toMatchObject({ code: 'RESOURCE_REDIRECT_LIMIT' });
});
it('rejects a redirect to a non-HTTP resource', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } })));
  await expect(fetchWorkspaceResource('https://assets.example/icon.svg')).rejects.toMatchObject({ code: 'RESOURCE_URL_BLOCKED' });
});
