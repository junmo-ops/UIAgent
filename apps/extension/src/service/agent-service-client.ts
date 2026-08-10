import { getInstallationAccessToken } from './installation-credential';

/**
 * Single transport boundary for Agent Service requests. Installation credentials are
 * provisioned without user interaction and can later be replaced by an SSO/OAuth provider.
 */
export async function agentServiceFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const requestUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const accessToken = await getInstallationAccessToken(requestUrl);
  const headers = new Headers(init.headers);
  if (accessToken && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }
  return fetch(input, {
    ...init,
    headers,
    credentials: 'include'
  });
}
