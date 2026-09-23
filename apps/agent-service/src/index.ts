import { readServiceConfig } from './configuration/service-config';
import { serve } from '@hono/node-server';
import { readWorkspaceStorageConfig } from './storage/config';
import { createApp } from './app';
import { SourceWorkspaceStore } from './workspace/store';
import { WorkspacePersistence } from './workspace/persistence';
import { S3WorkspaceStorage } from './storage/s3-workspace-storage';

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '127.0.0.1';
const serviceConfig = readServiceConfig();
const storageConfig = readWorkspaceStorageConfig();
const mode = storageConfig.mode;
let app: ReturnType<typeof createApp> | undefined;
let persistence: WorkspacePersistence | undefined;
let stopping = false;
// Listen during initialization so liveness probes do not kill a long restore.
const server = serve({ fetch: request => {
  const path = new URL(request.url).pathname;
  if (path === '/live') return Response.json({ alive: true });
  if (!app || stopping) return Response.json({ code: 'SERVICE_NOT_READY', message: '服务正在恢复副本或停止，请稍后重试' }, { status: 503 });
  return app.fetch(request);
}, port, hostname });
async function start() {
  let store: SourceWorkspaceStore | undefined;
  if (mode === 's3') {
    const root = storageConfig.cacheDirectory;
    persistence = new WorkspacePersistence(root, new S3WorkspaceStorage(process.env, storageConfig));
    await persistence.initialize();
    store = new SourceWorkspaceStore(persistence.root, {
      identityIsolation: true,
      frozenStyleVariantEnabled: serviceConfig.diagnostics.replicaAEnabled
    });
    store.persistence = persistence;
  }
  app = createApp(process.env, undefined, store, undefined, undefined, undefined, undefined, serviceConfig);
  console.log(`[agent-service] ready at ${hostname}:${port}; workspace storage=${mode}`);
}
void start().catch(error => {
  // Do not serialize SDK errors: endpoints and credentials must not enter logs.
  console.error('[agent-service] initialization failed:', error instanceof Error && !('requestId' in error) ? error.message : '对象存储初始化失败');
  server.close();
  process.exitCode = 1;
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  stopping = true;
  server.close();
  const deadline = Date.now() + 30000;
  const timer = setInterval(() => {
    if (!persistence?.activeWrites || Date.now() >= deadline) { clearInterval(timer); process.exit(0); }
  }, 250);
});
