import { constants } from 'node:crypto';
import { request } from 'node:https';

const LEGACY_TLS_ERROR = 'ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED';
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export function resourceErrorCode(error: unknown): string {
  let current = error;
  let code = 'RESOURCE_FETCH_FAILED';
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const item = current as { code?: unknown; cause?: unknown };
    if (typeof item.code === 'string' && /^[A-Z0-9_]+$/.test(item.code)) code = item.code;
    current = item.cause;
  }
  return code;
}

function fetchLegacyServer(url: URL): Promise<Response> {
  return new Promise((resolve, reject) => {
    // A private, non-pooled connection: do not relax TLS for other requests.
    const req = request(url, {
      agent: false,
      rejectUnauthorized: true,
      secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT
    }, res => {
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
        res.destroy();
        resolve(new Response(null, { status: res.statusCode, headers: res.headers.location ? { location: res.headers.location } : {} }));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      res.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_BYTES) {
          res.destroy(Object.assign(new Error('Resource exceeds 20 MB'), { code: 'RESOURCE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(Object.assign(new Error('Resource response aborted'), { code: 'RESOURCE_ABORTED' })));
      res.on('end', () => {
        try {
          resolve(new Response([204, 205, 304].includes(res.statusCode ?? 200) ? null : new Uint8Array(Buffer.concat(chunks)), {
            status: res.statusCode ?? 502,
            headers: { 'content-type': res.headers['content-type'] ?? 'application/octet-stream' }
          }));
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('Resource request timed out'), { code: 'RESOURCE_TIMEOUT' })), TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}

export async function fetchWorkspaceResource(urlString: string): Promise<Response> {
  let url = new URL(urlString);
  for (let hop = 0; hop <= 5; hop++) {
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw Object.assign(new Error('Unsupported resource URL'), { code: 'RESOURCE_URL_BLOCKED' });
    }
    const response = await fetchResourceHop(url);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw Object.assign(new Error('Missing redirect location'), { code: 'RESOURCE_REDIRECT_INVALID' });
    url = new URL(location, url);
  }
  throw Object.assign(new Error('Too many resource redirects'), { code: 'RESOURCE_REDIRECT_LIMIT' });
}

async function fetchResourceHop(url: URL): Promise<Response> {
  try {
    return await fetch(url, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    // Resource proxy only: retry legacy TLS without changing global TLS settings.
    if (resourceErrorCode(error) !== LEGACY_TLS_ERROR || url.protocol !== 'https:'
      || url.username || url.password) throw error;
    return fetchLegacyServer(url);
  }
}
