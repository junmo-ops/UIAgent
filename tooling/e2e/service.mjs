import { startS3Emulator } from './s3-emulator.mjs';
import { S3WorkspaceStorage } from '../../apps/agent-service/src/storage/s3-workspace-storage.ts';
import { WorkspacePersistence } from '../../apps/agent-service/src/workspace/persistence.ts';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../../apps/agent-service/src/app.ts';
import { ClineAssistantChatAdapter } from '../../packages/agent-runtime/src/adapters/cline-assistant-chat-adapter.ts';
import { SkillRegistry } from '../../apps/agent-service/src/skills/registry.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { SourceWorkspaceStore } from '../../apps/agent-service/src/workspace/store.ts';
const require = createRequire(new URL('../../apps/agent-service/package.json', import.meta.url));
const { serve } = require('@hono/node-server');
const root = resolve(process.env.E2E_DATA_DIR);
mkdirSync(root, { recursive: true });
const config = JSON.parse(readFileSync(new URL('../../apps/agent-service/config/service.json', import.meta.url)));
config.model = { baseUrl: 'http://127.0.0.1:1', name: 'deterministic-e2e', providerLabel: 'e2e', edit: config.model.edit, router: config.model.router };
config.auth.mode = 'development';
config.http = { publicBaseUrl: '', corsOrigin: '*' };
config.logging.file = resolve(root, 'turns.jsonl');
config.diagnostics.replicaAEnabled = false;
let scenario = { mode: 'edit' };
let state = {};
let releaseCreation;
const skillRoot = resolve(root, 'skills');
for (let i = 0; i < 24; i++) {
  const id = i === 0 ? 'e2e-python' : `e2e-skill-${i}`;
  const dir = resolve(skillRoot, id);
  mkdirSync(resolve(dir, 'scripts'), { recursive: true });
  writeFileSync(resolve(dir, 'skill.json'), JSON.stringify({ id, displayName: `测试技能${i}：用于验证窄侧栏长名称显示和开关操作`, description: '用于端到端回归的技能说明。'.repeat(12), scripts: i === 0 ? [{ path: 'scripts/report.py', runtime: 'python' }] : [] }));
  writeFileSync(resolve(dir, 'SKILL.md'), '# E2E fixture\nTrusted deterministic test script.');
  if (i === 0) writeFileSync(resolve(dir, 'scripts/report.py'), readFileSync(new URL('./python-fixture.py', import.meta.url)));
}
const skills = new SkillRegistry({ directory: skillRoot, pythonExecutable: 'python3', timeoutMs: 2000, maxConcurrentScripts: 1, maxOutputBytes: 131072, maxFiles: 20, maxInputBytes: 262144, maxRunsPerTurn: 3 });
if (!skills.pythonAvailable || skills.issues.length) throw new Error(`E2E Python unavailable or invalid fixtures: ${skills.issues}`);
const chat = new ClineAssistantChatAdapter({
  baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', modelName: 'e2e', skills,
  // Replace only the model decision loop. Use production chat adapter, tool
  // wrappers, registry, cancellation propagation and log recording unchanged.
  factory({ tools }) {
    const controller = new AbortController();
    let listener;
    return {
      subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
      abort(reason) { controller.abort(reason); },
      async run(raw) {
        const request = JSON.parse(raw), current = { ...scenario }, signal = controller.signal;
        const emit = text => listener?.({ type: 'assistant-text-delta', text });
        if (current.mode === 'stream') {
          let outputText = '';
          for (let i = 0; i < 200; i++) {
            signal.throwIfAborted();
            const chunk = `段落 ${i}：用于验证流式输出滚动跟随与暂停。\n\n`;
            outputText += chunk; emit(chunk); state.chunks = i + 1;
            await delay(80, undefined, { signal });
          }
          return { outputText };
        }
        const context = { agentId: 'e2e-model', iteration: 1, signal };
        const invoke = (name, input) => tools.find(tool => tool.name === name).execute(input, context);
        const input = { script: 'scripts/report.py', args: { mode: current.mode, text: '你好，E2E', marker: resolve(root, `marker-${request.turnId}.json`) }, inputs: [] };
        state.marker = input.args.marker;
        try {
          await invoke('load_skill', { id: 'e2e-python' });
          state.result = JSON.parse(await invoke('run_skill_script', input));
          const outputText = state.result.exitCode === 0 ? 'Python 已完成' : `Python 未完成：${state.result.stopped ?? state.result.exitCode}`;
          emit(outputText); return { outputText };
        } catch (error) { state.aborted = signal.aborted; throw error; }
        finally { state.finished = true; }
      }
    };
  }
});
const router = { adapterId: 'e2e-router', async route(request) {
  if (scenario.mode !== 'edit') return { kind: 'chat' };
  return { kind: 'page_edit', instruction: request.instruction, targetScope: 'selection' };
} };
const coding = { adapterId: 'e2e-coding', async run(turn, tools) {
  if (!turn.request.sourceId) throw new Error('E2E: selected sourceId was lost');
  await tools.setElementText(turn.request.sourceId, scenario.editText ?? 'E2E updated');
  const saved = await tools.commit('E2E deterministic text edit');
  if (scenario.rejectEditWrites) scenario.rejectWrites = true;
  return { response: { kind: 'completed', summary: 'E2E edit complete', revision: saved.revision, modelCalls: 0, toolCalls: 2 }, steps: [],
    checkpoint: { version: 1, adapterId: 'e2e-coding', workspaceId: turn.workspaceId, turnId: turn.request.turnId,
      status: 'completed', modelCalls: 0, toolCalls: 2, stepCount: 0, updatedAt: new Date().toISOString() } };
} };
const storage = { mode: 'local', cacheDirectory: resolve(root, 'workspaces'), s3: { endpoint: '', region: '', bucket: '', prefix: '', timeoutMs: 60000 }, archive: { bytes: 100000000, compressedBytes: 50000000, files: 10000 } };
let emulator, remote, persistence;
const storageMode = process.env.E2E_STORAGE ?? 'local';
if (storageMode !== 'local') {
  storage.mode = 's3'; storage.cacheDirectory = resolve(root, 's3-cache');
  let credentials;
  if (storageMode === 'emulated') {
    emulator = await startS3Emulator(resolve(root, 'emulated-objects'), () => scenario.rejectWrites === true);
    storage.s3 = { endpoint: emulator.endpoint, region: 'e2e', bucket: 'e2e', prefix: 'uiagent-e2e/emulated', timeoutMs: 3000 };
    credentials = { WORKSPACE_S3_ACCESS_KEY_ID: 'fixture', WORKSPACE_S3_SECRET_ACCESS_KEY: 'fixture' };
  } else if (storageMode === 'cos') {
    const settings = JSON.parse(readFileSync(process.env.E2E_COS_CONFIG, 'utf8'));
    if (Object.keys(settings).some(key => !['endpoint', 'region', 'bucket', 'prefix'].includes(key)) || ['endpoint', 'region', 'bucket', 'prefix'].some(key => typeof settings[key] !== 'string' || !settings[key].trim())) throw new Error('COS test config requires only endpoint, region, bucket and prefix');
    if (!/^uiagent-e2e\/[a-zA-Z0-9_-]+$/.test(settings.prefix)) throw new Error('COS test prefix must be uiagent-e2e/<test-name>');
    if (!/^[a-f0-9-]{36}$/.test(process.env.E2E_RUN_ID ?? '')) throw new Error('Missing unique COS test run ID');
    console.log(JSON.stringify({ cosRunId: process.env.E2E_RUN_ID }));
    storage.s3 = { ...settings, prefix: `${settings.prefix}/${process.env.E2E_RUN_ID}`, timeoutMs: 15000 };
    credentials = Object.fromEntries(['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SESSION_TOKEN'].map(name => [`WORKSPACE_S3_${name}`, process.env[`WORKSPACE_S3_${name}`]]));
  } else throw new Error('Unknown E2E storage mode');
  remote = new S3WorkspaceStorage(credentials, storage);
  persistence = new WorkspacePersistence(storage.cacheDirectory, remote);
  await persistence.initialize();
}
const store = new SourceWorkspaceStore(persistence?.root ?? storage.cacheDirectory, { identityIsolation: true, frozenStyleVariantEnabled: false });
store.persistence = persistence;
const app = createApp({ MODEL_API_KEY: 'e2e-placeholder-never-sent' }, undefined,
  store, coding,
  { mode: 'development', authenticate: () => ({ userId: 'e2e-user', tenantId: 'e2e', roles: ['user'], identityType: 'development' }) },
  router, chat, config, storage, skills);
const server = serve({ fetch: async request => {
  const path = new URL(request.url).pathname;
  if (path === '/__e2e/cleanup' && request.method === 'POST') {
    if (storageMode === 'cos') for (const id of await remote.list()) await remote.delete(id);
    return Response.json({ ok: true });
  }
  // Coordination endpoints exist only in this isolated test harness.
  if (path === '/__e2e/config' && request.method === 'POST') { scenario = await request.json(); state = {}; return Response.json({ ok: true }); }
  if (path === '/__e2e/release' && request.method === 'POST') { releaseCreation?.(); return Response.json({ ok: true }); }
  if (path === '/__e2e/state') {
    const marker = state.marker && existsSync(state.marker) ? JSON.parse(readFileSync(state.marker, 'utf8')) : undefined;
    let processAlive = false;
    if (marker) try { process.kill(marker.pid, 0); processAlive = true; } catch {}
    const logs = existsSync(config.logging.file) ? readFileSync(config.logging.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    return Response.json({ ...state, marker, processAlive, outputExists: marker ? existsSync(marker.outputDir) : false, logs });
  }
  if (path === '/v1/workspaces' && request.method === 'POST' && scenario.pauseCreation) {
    state.creationStarted = true;
    await new Promise(resolve => { releaseCreation = resolve; });
    releaseCreation = undefined;
  }
  return app.fetch(request);
}, hostname: '127.0.0.1', port: Number(process.env.E2E_PORT ?? 0) }, address => {
  console.log(JSON.stringify({ port: address.port }));
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { if (emulator) emulator.server.close(() => process.exit(0)); else process.exit(0); }));
