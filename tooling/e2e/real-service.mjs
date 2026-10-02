import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../../apps/agent-service/src/app.ts';
import { readServiceConfig } from '../../apps/agent-service/src/configuration/service-config.ts';
import { createModelRegistry } from '../../apps/agent-service/src/configuration/model-registry.ts';
import { SourceWorkspaceStore } from '../../apps/agent-service/src/workspace/store.ts';
import { SkillRegistry } from '../../apps/agent-service/src/skills/registry.ts';
const require = createRequire(new URL('../../apps/agent-service/package.json', import.meta.url));
const { serve } = require('@hono/node-server');
const root = resolve(process.env.E2E_DATA_DIR); mkdirSync(root, { recursive: true });
const config = readServiceConfig();
const modelId = process.env.REAL_MODEL_ID || 'default';
const selectedModel = modelId === 'default' ? { ...config.model, apiKeyEnv: 'MODEL_API_KEY', apiProtocol: 'chat-completions' }
  : config.model.alternatives?.find(item => item.id === modelId);
if (!selectedModel) throw new Error(`未配置测试模型：${modelId}`);
config.auth.mode = 'development'; config.http = { publicBaseUrl: '', corsOrigin: '*' };
config.logging.file = resolve(root, 'turns.jsonl');
const storage = { mode: 'local', cacheDirectory: resolve(root, 'workspaces'), s3: { endpoint: '', region: '', bucket: '', prefix: '', timeoutMs: 60000 }, archive: { bytes: 100000000, compressedBytes: 50000000, files: 10000 } };
const skills = new SkillRegistry();
const real = createModelRegistry(config, process.env, skills, {}).get(modelId);
// Expose one model in this isolated service. The real adapters above retain
// the selected definition's protocol and thinking settings; never fall back.
config.model = { ...config.model, baseUrl:selectedModel.baseUrl, name:selectedModel.name,
  providerLabel:selectedModel.providerLabel, alternatives:[] };
const routes = [];
const router = { adapterId: real.router.adapterId, async route(request) {
  const started = Date.now();
  const result = await real.router.route(request);
  routes.push({ workspaceId: request.context.workspaceId, turnId: request.turnId, instruction: request.instruction, replyToClarificationId: request.replyToClarificationId, clarificationOptionId: request.clarificationOptionId, result, durationMs: Date.now() - started });
  return result;
} };
const app = createApp({ MODEL_API_KEY: process.env[selectedModel.apiKeyEnv] }, undefined,
  new SourceWorkspaceStore(storage.cacheDirectory, { identityIsolation: true, frozenStyleVariantEnabled: config.diagnostics.replicaAEnabled }), real.coding,
  { mode: 'development', authenticate: () => ({ userId: 'e2e-user', tenantId: 'e2e', roles: ['user'], identityType: 'development' }) }, router, real.chat, config, storage, skills);
const server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
  const path = new URL(request.url).pathname;
  if (path === '/__e2e/config' || path === '/__e2e/release') return Response.json({ ok: true });
  if (path === '/__e2e/state') return Response.json({ routes, model: { configuredId:modelId, apiProtocol:selectedModel.apiProtocol ?? 'chat-completions', enableThinking:selectedModel.enableThinking, name: config.model.name, provider: config.model.providerLabel, baseUrl: config.model.baseUrl, edit: config.model.edit, router: config.model.router }, logs: existsSync(config.logging.file) ? readFileSync(config.logging.file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] });
  return app.fetch(request);
}}, address => console.log(JSON.stringify({ port: address.port })));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
