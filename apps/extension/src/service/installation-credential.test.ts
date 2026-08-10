import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageState = vi.hoisted(() => ({
  value: {} as Record<string, unknown>
}));

vi.mock('wxt/utils/storage', () => ({
  storage: {
    defineItem: () => ({
      getValue: async () => storageState.value,
      setValue: async (value: Record<string, unknown>) => { storageState.value = value; }
    })
  }
}));

import { agentServiceFetch } from './agent-service-client';

describe('installation credential transport', () => {
  beforeEach(() => {
    storageState.value = {};
    vi.restoreAllMocks();
  });

  it('provisions once, persists by service origin, and attaches the signed credential', async () => {
    const accessToken = 'signed-installation-token'.padEnd(40, '-');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/v1/auth/installations')) {
        return new Response(JSON.stringify({
          accessToken,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await agentServiceFetch('https://pilot.example.test/health');
    await agentServiceFetch('https://pilot.example.test/v1/workspaces');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstApiHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    const secondApiHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers);
    expect(firstApiHeaders.get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(secondApiHeaders.get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(storageState.value).toMatchObject({
      'https://pilot.example.test': { accessToken, serviceOrigin: 'https://pilot.example.test' }
    });
  });
});
