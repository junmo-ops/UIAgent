// Service/SDK/HTTP/filesystem integration probe; no real model or user data.
// Run with the repository's tsx loader. Separate from model-backed benchmarks.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../apps/agent-service/src/app.ts';
import { SourceWorkspaceStore } from '../../apps/agent-service/src/workspace/store.ts';
import { ClineCodingAgentAdapter } from '../../packages/agent-runtime/src/adapters/cline-coding-agent-adapter.ts';

const require = createRequire(new URL('../../apps/agent-service/package.json', import.meta.url));
const { serve } = require('@hono/node-server');
const output = resolve(process.argv[2] || `output/real-model/protocol-integration-${Date.now()}`);
mkdirSync(output, { recursive: false });
const report = { kind: 'service-transport-fault-integration', realModel: false, browserRendering: false,
  probeSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  runtimeSha256: createHash('sha256').update(readFileSync(new URL('../../packages/agent-runtime/vendor/ui-agent-runtime/index.js', import.meta.url))).digest('hex'), scenarios: [] };
const check = (fact, message) => { if (!fact) throw new Error(message); };
const close = async server => { if (server) { server.closeAllConnections?.(); await new Promise(done => server.close(done)); } };

for (const mode of ['recover-after-prior-write', 'second-malformed-response', 'discard-buffered-tool-on-malformed-response']) {
  const root = mkdtempSync(resolve(tmpdir(), 'uiagent-protocol-integration-'));
  let provider, service, requests = 0;
  const row = { mode, status: 'running' }; report.scenarios.push(row);
  try {
    provider = createServer(async (request, response) => {
      // Fully consume the SDK request, but never log its body or headers.
      for await (const chunk of request) { /* drain */ }
      const number = ++requests;
      const actions = [
        ['read_file', { path: 'index.html' }],
        ['declare_intent', { summary: '把按钮文案改为完成', interactionPlan: { mode: 'none' }, relevantSourceIds: ['source-0'] }],
        ['set_element_text', { sourceId: 'source-0', text: '完成' }],
        [null, {}],
        [mode === 'second-malformed-response' ? null : 'finish', { summary: '已修改按钮文案' }]
      ];
      const [name, input] = actions[number - 1] ?? [null, {}];
      const envelope = { id: `fixture-${number}`, object: 'chat.completion.chunk', created: 1, model: 'protocol-fixture' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (mode === 'discard-buffered-tool-on-malformed-response' && number === 4) {
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'current-write', type: 'function', function: { name: 'set_element_text', arguments: JSON.stringify({ sourceId: 'source-0', text: '中间状态' }) } }] }, finish_reason: null }] })}\n\n`);
        await delay(150);
        response.end(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'malformed-next', type: 'function', function: { name: null, arguments: '{}' } }] }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${number}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
    const config = JSON.parse(readFileSync(new URL('../../apps/agent-service/config/service.json', import.meta.url)));
    config.model = { baseUrl, name: 'protocol-fixture', providerLabel: 'fixture', edit: { maxIterations: 8, maxOutputTokens: 8192 }, router: { maxIterations: 3 } };
    config.auth.mode = 'development'; config.http = { publicBaseUrl: '', corsOrigin: '*' };
    config.logging.file = resolve(root, 'turns.jsonl'); config.diagnostics.replicaAEnabled = false;
    const storage = { mode: 'local', cacheDirectory: resolve(root, 'workspaces'), s3: { endpoint: '', region: '', bucket: '', prefix: '', timeoutMs: 60000 }, archive: { bytes: 100000000, compressedBytes: 50000000, files: 10000 } };
    const store = new SourceWorkspaceStore(storage.cacheDirectory, { identityIsolation: true });
    const owner = { userId: 'protocol-fixture', tenantId: 'e2e', roles: ['user'], identityType: 'development' };
    const coding = new ClineCodingAgentAdapter({ baseUrl, apiKey: 'local-fixture', modelName: 'protocol-fixture', maxIterations: 8 });
    const app = createApp({ MODEL_API_KEY: 'local-fixture' }, undefined, store, coding,
      { mode: 'development', authenticate: () => owner }, undefined, undefined, config, storage);
    service = serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
    if (!service.listening) await once(service, 'listening');
    const serviceUrl = `http://127.0.0.1:${service.address().port}`;
    const post = async (path, value) => {
      const response = await fetch(serviceUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(10000) });
      check(response.ok, `HTTP ${response.status} at ${path}`); return response.json();
    };
    const created = await post('/v1/workspaces', { protocolVersion: '1.0', title: 'Protocol fixture', sourceUrl: 'https://fixture.test/', capturedAt: new Date().toISOString(),
      html: '<!doctype html><html><body><button data-ui-source-id="source-0">查询</button></body></html>',
      authorStyles: { cssText: 'button { color: black }', readableSheets: 1, unreadableSheets: 0, missing: [] }, nodeCount: 1, selectedSourceId: 'source-0', viewport: { width: 800, height: 600 } });
    const turnId = randomUUID();
    await post(`/v1/workspaces/${created.workspaceId}/turns`, { protocolVersion: '1.0', editSessionId: randomUUID(), turnId, traceId: randomUUID(), instruction: '只把按钮文案查询改成完成。', sourceId: 'source-0' });
    let progress;
    for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
      const response = await fetch(`${serviceUrl}/v1/workspaces/${created.workspaceId}/turns/${turnId}/progress`, { signal: AbortSignal.timeout(5000) });
      progress = await response.json();
      if (progress.result || ['failed', 'completed', 'cancelled'].includes(progress.status)) break;
      await delay(50);
    }
    const logs = readFileSync(config.logging.file, 'utf8').trim().split('\n').map(JSON.parse);
    const entry = logs.filter(log => log.request?.turnId === turnId).at(-1);
    const runtime = entry?.codingAgent?.checkpoint?.runtime;
    const context = store.readContext(created.workspaceId, owner);
    const html = await context.tools.readFile('index.html');
    const writes = runtime?.calls.flatMap(call => call.tools).filter(tool => tool.name === 'set_element_text' && tool.status === 'succeeded').length;
    Object.assign(row, { requests, result: progress.result, revision: context.revision, successfulTextWrites: writes, runtime });
    check(runtime?.protocolRecoveryCount === 1, 'Expected exactly one recorded protocol recovery');
    check(requests === 5 && writes === 1, 'Recovery must not replay the previous source write or retry indefinitely');
    if (mode === 'discard-buffered-tool-on-malformed-response') {
      // This installed SDK only finalizes tool calls when its stream flushes.
      // A valid buffered payload followed by malformed data has not executed.
      check(runtime.calls[3].tools.length === 0 && progress.result?.kind === 'completed' && context.revision === 1 && html.includes('完成') && !html.includes('中间状态'), 'Discard buffered payload without executing it during recovery');
      await delay(200);
      check((await store.readContext(created.workspaceId, owner).tools.readFile('index.html')) === html, 'Discarded response must not produce a late write');
    }
    if (mode === 'recover-after-prior-write') {
      check(progress.result?.kind === 'completed' && context.revision === 1 && html.includes('完成'), 'Expected one committed revision after recovery');
      check(runtime.calls[3].status === 'failed' && runtime.calls[4].status === 'completed', 'Failed response evidence must be retained');
    } else if (mode === 'second-malformed-response') {
      check(progress.result?.kind === 'failed' && context.revision === 0 && html.includes('查询') && !html.includes('完成'), 'Repeated malformed response must fail and restore original source');
    }
    row.status = 'passed';
  } catch (error) { row.status = 'failed'; row.error = error.message; process.exitCode = 1; }
  finally { await close(service); await close(provider); rmSync(root, { recursive: true, force: true }); }
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ mode, status: row.status, requests, error: row.error }));
}
