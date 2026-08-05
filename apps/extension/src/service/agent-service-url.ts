const LOCAL_AGENT_SERVICE_URL = 'http://127.0.0.1:8787';

export function normalizeAgentServiceUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  const url = new URL(normalized);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Agent Service 地址必须是 HTTP/HTTPS 服务根地址');
  }
  return url.origin;
}

export const DEFAULT_AGENT_SERVICE_URL = normalizeAgentServiceUrl(
  import.meta.env.WXT_PUBLIC_AGENT_SERVICE_URL || LOCAL_AGENT_SERVICE_URL
);

export function isWorkspacePreviewUrl(url: string | undefined, serviceUrl: string): boolean {
  if (!url) return false;
  try {
    const candidate = new URL(url);
    const service = new URL(normalizeAgentServiceUrl(serviceUrl));
    return candidate.origin === service.origin
      && /^\/workspaces\/[0-9a-f-]{36}\/preview\/?$/i.test(candidate.pathname);
  } catch {
    return false;
  }
}
