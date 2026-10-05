// Read-only local preview for reviewing isolated workspace replay results.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createApp } from '../../apps/agent-service/src/app.ts';
import { SourceWorkspaceStore } from '../../apps/agent-service/src/workspace/store.ts';
import { readServiceConfig } from '../../apps/agent-service/src/configuration/service-config.ts';
const require = createRequire(new URL('../../apps/agent-service/package.json', import.meta.url));
const { serve } = require('@hono/node-server');
const [rootPath, workspaceId] = process.argv.slice(2);
if (!rootPath || !workspaceId) throw new Error('Usage: serve-replay-preview.mjs WORKSPACE_ROOT WORKSPACE_ID');
const root = resolve(rootPath);
const manifest = JSON.parse(readFileSync(resolve(root, workspaceId, 'workspace.json'), 'utf8'));
const config = readServiceConfig();
config.auth.mode = 'development'; config.http = { publicBaseUrl: '', corsOrigin: '*' };
config.logging.file = resolve(root, 'preview-logs.jsonl');
const storage = { mode: 'local', cacheDirectory: root, s3: { endpoint: '', region: '', bucket: '', prefix: '', timeoutMs: 60000 },
  archive: { bytes: 100000000, compressedBytes: 50000000, files: 10000 } };
const unavailable = () => { throw new Error('Model execution disabled in review preview'); };
const app = createApp({}, undefined, new SourceWorkspaceStore(root), { adapterId: 'review-only', run: unavailable },
  { mode: 'development', authenticate: () => ({ userId: manifest.ownerId, tenantId: manifest.tenantId, roles: ['user'], identityType: 'development' }) },
  { adapterId: 'review-only', route: unavailable }, { adapterId: 'review-only', chat: unavailable, run: unavailable }, config, storage);
const server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => request.method === 'GET'
  ? app.fetch(request) : Response.json({ error: 'Review preview is read-only' }, { status: 405 }) },
  address => console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}/workspaces/${workspaceId}/preview?candidate=B` })));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
