import { getAuthConfig, getSsoAccessToken, clearSsoSession } from './sso-session';
import { getInstallationAccessToken } from './installation-credential';

/**
 * Single transport boundary for Agent Service requests. Installation credentials are
 * provisioned without user interaction; external mode only uses an explicit SSO session.
 */
export async function agentServiceFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const requestUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const origin = new URL(requestUrl).origin;
  const external = (await getAuthConfig(origin)).mode === 'external';
  const accessToken = external ? await getSsoAccessToken(origin) : await getInstallationAccessToken(requestUrl);
  const headers = new Headers(init.headers);
  if (accessToken && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }
  const response = await fetch(input, {
    ...init,
    headers,
    credentials: 'include'
  });
  if (external && response.status === 401) await clearSsoSession(origin);
  return response;
}
