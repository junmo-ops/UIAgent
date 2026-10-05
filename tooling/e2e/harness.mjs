import { test, expect, chromium } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layouts, fixtureHtml } from './layouts.mjs';
import { complexPages } from './complex-cases.mjs';
import { connectTarget, buttonExpression } from './cdp.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
let temp, service, fixtureServer, serviceUrl, sourceUrl, extensionDir;
let serviceLog = '';
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test' });
async function build(args, options) {
  const child = spawn(process.execPath, args, options);
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  await new Promise((ok, fail) => { child.on('error', fail); child.on('exit', code => code === 0 ? ok() : fail(new Error(output))); });
}

const runId = randomUUID();
let storageMode = 'local';
async function startService() {
  let bootLog = '';
  service = spawn(process.execPath, [...(process.env.UIAGENT_REAL_MODEL ? ['--env-file=' + resolve(repo, 'apps/agent-service/.env')] : []), '--import', resolve(repo, 'apps/agent-service/node_modules/tsx/dist/loader.mjs'), resolve(repo, process.env.UIAGENT_REAL_MODEL ? 'tooling/e2e/real-service.mjs' : 'tooling/e2e/service.mjs')], {
    cwd: repo, env: { ...cleanEnv(), REAL_MODEL_ID: process.env.REAL_MODEL_ID ?? 'default', REAL_EDIT_REASONING_FILE: process.env.REAL_EDIT_REASONING_FILE, E2E_DATA_DIR: resolve(temp, 'data'), E2E_PORT: serviceUrl ? new URL(serviceUrl).port : '0', E2E_STORAGE: storageMode, E2E_RUN_ID: runId, E2E_COS_CONFIG: process.env.E2E_COS_CONFIG, ...(storageMode === 'cos' ? Object.fromEntries(['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SESSION_TOKEN'].map(name => [`WORKSPACE_S3_${name}`, process.env[`WORKSPACE_S3_${name}`]])) : {}) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  service.stdout.on('data', data => { serviceLog += data; bootLog += data; }); service.stderr.on('data', data => { serviceLog += data; bootLog += data; });
  await expect.poll(() => { if (service.exitCode !== null) throw new Error(`Test service exited: ${bootLog}`); return bootLog.match(/\{"port":(\d+)\}/)?.[1]; }, { timeout: 30000, message: 'Isolated service ready' }).toBeTruthy();
  serviceUrl = `http://127.0.0.1:${bootLog.match(/\{"port":(\d+)\}/)[1]}`;
}
async function stopService() {
  if (service && service.exitCode === null) {
    const exited = new Promise(ok => service.once('exit', ok));
    service.kill('SIGTERM');
    const force = setTimeout(() => service.kill('SIGKILL'), 5000);
    await exited; clearTimeout(force);
  }
}
async function restartService(mode = storageMode, clearCache = false) {
  await stopService(); storageMode = mode;
  if (clearCache) rmSync(resolve(temp, 'data/s3-cache'), { recursive: true, force: true });
  await startService();
}
test.beforeAll(async () => {
  test.setTimeout(120000);
  temp = mkdtempSync(resolve(tmpdir(), 'uiagent-e2e-'));
  extensionDir = resolve(temp, 'extension');
  await startService();
  const demoDir = resolve(temp, 'demo');
  if (process.env.REAL_SUITE === 'demo') {
    await build([resolve(repo, 'apps/demo-page/node_modules/vite/bin/vite.js'), 'build', '--base', '/demo/', '--outDir', demoDir], {
      cwd: resolve(repo, 'apps/demo-page'), env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe']
    });
  }
  fixtureServer = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture.test').pathname;
    if (process.env.REAL_SUITE === 'demo' && pathname.startsWith('/demo/')) {
      const path = resolve(demoDir, '.' + pathname.slice('/demo'.length), pathname.endsWith('/') ? 'index.html' : '');
      if (!path.startsWith(demoDir + '/')) { res.writeHead(403).end(); return; }
      try {
        const types = { html:'text/html; charset=utf-8', js:'text/javascript', css:'text/css', svg:'image/svg+xml' };
        res.writeHead(200, { 'content-type': types[path.split('.').pop()] ?? 'application/octet-stream' }); res.end(readFileSync(path));
      } catch { res.writeHead(404).end(); }
      return;
    }
    const layout = pathname.slice(1);
    if (!(layout in layouts) && !(layout in complexPages)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(complexPages[layout] ?? fixtureHtml(layout));
  });
  await new Promise(ok => fixtureServer.listen(0, '127.0.0.1', ok));
  // Only the launcher matches this origin; capture must inject the editing script.
  sourceUrl = `http://fixture.test:${fixtureServer.address().port}`;
  await build([resolve(repo, 'apps/extension/node_modules/wxt/bin/wxt.mjs'), 'build', '--browser', 'chrome', '--config', resolve(repo, 'tooling/e2e/wxt.config.ts')], {
    cwd: resolve(repo, 'apps/extension'), env: { ...cleanEnv(), WXT_PUBLIC_AGENT_SERVICE_URL: serviceUrl, E2E_EXTENSION_DIR: extensionDir }, stdio: ['ignore', 'pipe', 'pipe']
  });
});
test.afterAll(async () => {
  try {
    if (storageMode === 'cos' && service?.exitCode === null) {
      const cleaned = await fetch(`${serviceUrl}/__e2e/cleanup`, { method: 'POST', signal: AbortSignal.timeout(30000) });
      if (!cleaned.ok) throw new Error(`COS test cleanup failed; run ID: ${runId}`);
    }
  } finally { await stopService(); }
  if (fixtureServer) await new Promise(ok => fixtureServer.close(ok));
  if (temp) rmSync(temp, { recursive: true, force: true });
});
async function withPanel(layout, info, run) {
  const profile = mkdtempSync(resolve(temp, 'profile-'));
  await configure({ mode: 'edit' });
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', executablePath: process.env.E2E_CHROMIUM_EXECUTABLE, headless: false, viewport: null,
    args: [`--disable-extensions-except=${extensionDir}/chrome-mv3`, `--load-extension=${extensionDir}/chrome-mv3`, '--remote-debugging-port=0', '--window-size=1280,900', '--host-resolver-rules=MAP fixture.test 127.0.0.1', '--no-proxy-server'] });
  const errors = [];
  context.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = context.pages()[0];
  let panel;
  let failed = false;
  try {
    await page.goto(`${sourceUrl}/${layout}`);
    if (layout.startsWith('demo/')) await page.getByRole('heading').first().waitFor({ state: 'visible' });
    const launcher = page.locator('[data-ui-agent-launcher]');
    await expect(launcher).toBeVisible();
    await launcher.click({ position: { x: 20, y: 20 } });
    const debugPort = readFileSync(resolve(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    let target;
    let targets = [];
    await expect.poll(async () => {
      targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      target = targets.find(t => t.url.startsWith('chrome-extension://') && t.url.endsWith('/sidepanel.html'));
      return Boolean(target);
    }, { timeout: 15000, message: 'Real browser side panel target exists (not an extension tab)' }).toBe(true);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const nativeContexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
    expect(nativeContexts.some(item => item.documentUrl === target.url)).toBe(true);
    await info.attach('native-sidepanel-context.json', { body: JSON.stringify(nativeContexts, null, 2), contentType: 'application/json' });
    panel = await connectTarget(target.webSocketDebuggerUrl);
    const ready = label => panel.evaluate(`Boolean(${buttonExpression(label)} && !${buttonExpression(label)}.disabled)`);
    const click = async label => { await expect.poll(() => ready(label)).toBe(true); await panel.evaluate(`${buttonExpression(label)}.click()`); };
    await run({ page, panel, context, worker, click, ready });
  } catch (error) { failed = true; throw error; } finally {
    await fetch(`${serviceUrl}/__e2e/release`, { method: 'POST' }).catch(() => {});
    await info.attach('service.log', { body: serviceLog, contentType: 'text/plain' });
    await info.attach('browser-errors.json', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' });
    if (failed || info.status !== info.expectedStatus) {
      await page.screenshot({ path: info.outputPath('page.png') }).catch(() => {});
      if (panel) await info.attach('sidepanel.html', { body: await panel.evaluate('document.documentElement.outerHTML').catch(String), contentType: 'text/html' });
    }
    panel?.close();
    await context.tracing.stop({ path: info.outputPath('trace.zip') });
    await context.close();
  }
}

const configure = value => fetch(`${serviceUrl}/__e2e/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const state = async () => (await fetch(`${serviceUrl}/__e2e/state`, {signal:AbortSignal.timeout(10000)})).json();
const fill = async (panel, text) => { await expect.poll(() => panel.evaluate(`Boolean(document.querySelector('textarea'))`)).toBe(true); return panel.evaluate(`(() => { const input = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`); };
async function nativeClick(panel, selector) {
  const rect = await panel.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
}

export { withPanel, configure, state, fill, nativeClick, restartService, storageMode, serviceUrl, sourceUrl };
