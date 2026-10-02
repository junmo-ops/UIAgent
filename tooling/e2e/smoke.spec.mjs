import { test, expect } from '@playwright/test';
import { layouts } from './layouts.mjs';
import { buttonExpression } from './cdp.mjs';
import { createHash } from 'node:crypto';
import { withPanel, configure, state, fill, nativeClick, restartService, storageMode, serviceUrl, sourceUrl } from './harness.mjs';
for (const layout of Object.keys(layouts)) test(`${layout}: native side panel → replica → selection → edit → undo`, async ({}, info) => withPanel(layout, info, async ({ page, panel, click, ready }) => {
    await click('进入副本编辑');
    await page.waitForURL(/\/workspaces\/[^/]+\/preview/, { timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'E2E target', exact: true })).toBeVisible();
    await click('选择区域');
    await page.getByRole('heading', { name: 'E2E target', exact: true }).click();
    await expect.poll(() => ready('当前选区，点击重选')).toBe(true);
    // Cross the 7s editor lease to verify heartbeat renewal preserves selection.
    await page.waitForTimeout(8000);
    await expect.poll(() => ready('当前选区，点击重选')).toBe(true);
    await panel.evaluate(`(() => { const input = document.querySelector('textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, 'Change selected heading'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('发送');
    await expect(page.getByRole('heading', { name: 'E2E updated', exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Other heading', exact: true })).toHaveCount(1);
    const box = await page.getByRole('heading', { name: 'E2E updated', exact: true }).boundingBox();
    expect(box.width).toBeGreaterThan(0); expect(box.height).toBeGreaterThan(0);
    await click('撤销页面修改');
    await expect(page.getByRole('heading', { name: 'E2E target', exact: true })).toBeVisible();
    await click('重做页面修改');
    await expect(page.getByRole('heading', { name: 'E2E updated', exact: true })).toBeVisible();
    await expect.poll(() => panel.evaluate(`Boolean(${buttonExpression('运行日志')})`)).toBe(false);
    expect((await fetch(`${serviceUrl}/logs`)).status).toBe(403);
}));

test('tab switch while creating replica preserves source binding', async ({}, info) => withPanel('flow', info, async ({ page, panel, context, worker, click }) => {
  await configure({ mode: 'edit', pauseCreation: true });
  await click('进入副本编辑');
  await expect.poll(async () => (await state()).creationStarted).toBe(true);
  const other = await context.newPage();
  await other.goto(`${sourceUrl}/grid`); await other.bringToFront();
  await fetch(`${serviceUrl}/__e2e/release`, { method: 'POST' });
  await page.waitForURL(/\/workspaces\/[^/]+\/preview/);
  expect(other.url()).toBe(`${sourceUrl}/grid`);
  const active = await worker.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
  expect(active[0].url).toBe(other.url());
  await page.bringToFront();
  await click('选择区域');
  await page.getByRole('heading', { name: 'E2E target', exact: true }).click();
  await fill(panel, 'Change selected heading'); await click('发送');
  await expect(page.getByRole('heading', { name: 'E2E updated', exact: true })).toBeVisible();
  await expect(other.getByRole('heading', { name: 'E2E target', exact: true })).toHaveCount(1);
}));

test('stream follows bottom, pauses on wheel up, resumes at bottom', async ({}, info) => withPanel('flow', info, async ({ page, panel, click }) => {
  await click('进入副本编辑'); await page.waitForURL(/\/workspaces\/[^/]+\/preview/);
  await configure({ mode: 'stream' });
  await fill(panel, 'Generate a long response'); await click('发送');
  const metrics = () => panel.evaluate(`(() => { const e = document.querySelector('.chat-list'); return { top:e.scrollTop, height:e.scrollHeight, viewport:e.clientHeight, gap:e.scrollHeight-e.clientHeight-e.scrollTop }; })()`);
  await expect.poll(async () => { const m = await metrics(); return m.height > m.viewport * 2 && m.gap < 5; }).toBe(true);
  const point = await panel.evaluate(`(() => { const r=document.querySelector('.chat-list').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await panel.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -600 });
  await expect.poll(async () => (await metrics()).gap).toBeGreaterThan(100);
  const paused = await metrics(); const chunks = (await state()).chunks;
  await expect.poll(async () => (await state()).chunks).toBeGreaterThan(chunks + 5);
  expect(Math.abs((await metrics()).top - paused.top)).toBeLessThan(5);
  await panel.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 100000 });
  await expect.poll(async () => (await metrics()).gap).toBeLessThan(5);
  const resumed = (await state()).chunks;
  await expect.poll(async () => (await state()).chunks).toBeGreaterThan(resumed + 5);
  expect((await metrics()).gap).toBeLessThan(5);
  await click('停止生成');
}));

test('narrow skill panel: long labels, scroll, click and saved toggle', async ({}, info) => withPanel('flow', info, async ({ panel, click }) => {
  await panel.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 600, deviceScaleFactor: 1, mobile: false });
  await click('技能');
  await expect.poll(() => panel.evaluate(`document.querySelectorAll('.skill-setting-row').length`)).toBe(24);
  const geometry = await panel.evaluate(`(() => { const e=document.querySelector('section[aria-label="技能"]'); const r=e.getBoundingClientRect(); const list=e.querySelector('.conversation-list'); return { left:r.left,right:r.right,width:innerWidth,overflow:e.scrollWidth-e.clientWidth,scrollable:list.scrollHeight>list.clientHeight }; })()`);
  expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.overflow).toBeLessThanOrEqual(1); expect(geometry.scrollable).toBe(true);
  const selector = '.skill-setting-row:last-child button[role="switch"]';
  const name = await panel.evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-label')`);
  await nativeClick(panel, selector);
  await expect.poll(() => panel.evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')`)).toBe('false');
  // Verify the actual visible switch is inside the viewport after scrolling.
  expect(await panel.evaluate(`(() => { const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })()`)).toBe(true);
  await click('关闭技能面板'); await panel.send('Page.reload'); await click('技能');
  await expect.poll(() => panel.evaluate(`[...document.querySelectorAll('button[role="switch"]')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(name)})?.getAttribute('aria-checked')`)).toBe('false');
  await info.attach('skill-panel.png', { body: Buffer.from((await panel.send('Page.captureScreenshot')).data, 'base64'), contentType: 'image/png' });
}));

for (const mode of ['success', 'failure', 'timeout', 'cancel']) test(`Python skill: ${mode}, log and process cleanup`, async ({}, info) => withPanel('flow', info, async ({ page, panel, click }) => {
  await click('进入副本编辑'); await page.waitForURL(/\/workspaces\/[^/]+\/preview/);
  await configure({ mode });
  await fill(panel, `Run Python ${mode}`); await click('发送');
  await expect.poll(async () => Boolean((await state()).marker)).toBe(true);
  if (mode === 'cancel') {
    expect((await state()).processAlive).toBe(true);
    await click('停止生成');
  }
  await expect.poll(async () => (await state()).finished, { timeout: 10000 }).toBe(true);
  await expect.poll(async () => (await state()).logs.some(log => log.kind === 'assistant_turn' && log.request.instruction === `Run Python ${mode}`)).toBe(true);
  const result = await state();
  expect(result.processAlive).toBe(false); expect(result.outputExists).toBe(false);
  const log = result.logs.findLast(log => log.kind === 'assistant_turn' && log.request.instruction === `Run Python ${mode}`);
  expect(log.assistantSteps.some(step => step.action === 'run_skill_script')).toBe(true);
  if (mode === 'success') {
    expect(result.result.exitCode).toBe(0);
    const artifact = JSON.parse(result.result.artifacts.find(a => a.path === 'report.json').text);
    expect(artifact.sha256).toBe(createHash('sha256').update('你好，E2E').digest('hex'));
    expect(artifact.pid).toBe(result.marker.pid);
    expect(log.assistantSteps.find(step => step.action === 'run_skill_script').result).toContain(artifact.sha256);
    await expect.poll(() => panel.evaluate(`document.querySelector('.chat-list').textContent.includes('Python 已完成')`)).toBe(true);
  } else if (mode === 'failure') {
    expect(result.result.exitCode).toBe(7); expect(result.result.stderr).toContain('deliberate script failure'); expect(result.result.artifacts).toEqual([]);
  } else if (mode === 'timeout') {
    expect(result.result.stopped).toBe('timeout'); expect(result.result.artifacts).toEqual([]);
  } else {
    expect(result.aborted).toBe(true); expect(log.result.kind).toBe('failed');
  }
  await info.attach('python-evidence.json', { body: JSON.stringify({ ...result, logs: [log] }, null, 2), contentType: 'application/json' });
  // A follow-up succeeds after failure/timeout/cancel: no leaked concurrency slot.
  if (mode !== 'success') {
    await configure({ mode: 'success' });
    await fill(panel, 'Run recovery Python'); await click('发送');
    await expect.poll(async () => (await state()).result?.exitCode, { timeout: 10000 }).toBe(0);
  }
}));

async function createEditedReplica({ page, panel, click, ready }) {
  await click('进入副本编辑'); await page.waitForURL(/\/workspaces\/[^/]+\/preview/);
  await click('选择区域'); await page.getByRole('heading', { name: 'E2E target', exact: true }).click();
  await fill(panel, 'Persist this edit'); await click('发送');
  await expect(page.getByRole('heading', { name: 'E2E updated', exact: true })).toBeVisible();
  await expect.poll(() => ready('撤销页面修改')).toBe(true);
  return new URL(page.url()).pathname.split('/')[2];
}
const api = async path => {
  const response = await fetch(`${serviceUrl}${path}`);
  expect(response.ok, `GET ${path}`).toBe(true);
  return response.json();
};
async function persistenceRoundtrip(mode, info) {
  if (mode !== storageMode) await restartService(mode, true);
  await withPanel('flow', info, async controls => {
    const { page, panel, click } = controls;
    const id = await createEditedReplica(controls);
    const base = `/v1/workspaces/${id}`;
    await expect.poll(async () => (await api(`${base}/conversation`)).entries.some(entry => entry.text?.includes('E2E edit complete'))).toBe(true);
    const before = { workspace: await api(base), conversations: await api(`${base}/conversations`), chat: await api(`${base}/conversation`) };
    // Keep a redo branch across process restart, not only the last saved version.
    await click('撤销页面修改');
    await expect(page.getByRole('heading', { name: 'E2E target', exact: true })).toBeVisible();
    const undone = await api(base);
    await restartService(mode, mode !== 'local');
    const after = { workspace: await api(base), conversations: await api(`${base}/conversations`), chat: await api(`${base}/conversation`) };
    expect(after.workspace.revision).toBe(undone.revision);
    expect(after.workspace.canRedo).toBe(true);
    expect(after.chat).toEqual(before.chat);
    expect(after.conversations).toEqual(before.conversations);
    expect((await api('/v1/workspaces?limit=100')).items.some(item => item.workspaceId === id)).toBe(true);
    await page.reload(); await panel.send('Page.reload');
    await expect(page.getByRole('heading', { name: 'E2E target', exact: true })).toBeVisible();
    await expect.poll(() => panel.evaluate(`document.querySelector('.chat-list')?.textContent.includes('Persist this edit')`)).toBe(true);
    await click('重做页面修改');
    await expect(page.getByRole('heading', { name: 'E2E updated', exact: true })).toBeVisible();
    expect((await api(base)).revision).toBe(before.workspace.revision);
    await click('撤销页面修改');
    await expect(page.getByRole('heading', { name: 'E2E target', exact: true })).toBeVisible();
    await info.attach('persistence-evidence.json', { body: JSON.stringify({ mode, clearedLocalCache: mode !== 'local', before, after }, null, 2), contentType: 'application/json' });
  });
}
test('persistence: local service restart restores revisions and conversations', async ({}, info) => persistenceRoundtrip('local', info));
test('persistence: S3 emulation restores ZIP after cache deletion', async ({}, info) => persistenceRoundtrip('emulated', info));
test('persistence: S3 rejected upload never publishes success', async ({}, info) => {
  if (storageMode !== 'emulated') await restartService('emulated', true);
  await withPanel('flow', info, async controls => {
    const { page, panel, click, ready } = controls;
    const id = await createEditedReplica(controls);
    const original = await api(`/v1/workspaces/${id}`);
    await configure({ mode: 'edit', rejectEditWrites: true, editText: 'E2E unsaved' });
    await click('当前选区，点击重选');
    await page.getByRole('heading', { name: 'E2E updated', exact: true }).click();
    await fill(panel, 'Fail to save edit'); await click('发送');
    await expect.poll(async () => (await state()).logs.some(log => log.request.instruction === 'Fail to save edit' && log.result.kind === 'failed'), { timeout: 15000 }).toBe(true);
    await expect.poll(() => panel.evaluate(`[...document.querySelectorAll('.agent-activity-notice')].some(e => e.textContent.includes('本轮未完成'))`)).toBe(true);
    const failed = (await state()).logs.filter(log => log.request.instruction === 'Fail to save edit');
    expect(failed.every(log => log.result.kind !== 'completed')).toBe(true);
    expect((await api(`/v1/workspaces/${id}`)).revision).toBe(original.revision);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'E2E updated', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'E2E unsaved', exact: true })).toHaveCount(0);
    await restartService('emulated', true);
    await page.reload(); await panel.send('Page.reload');
    await expect(page.getByRole('heading', { name: 'E2E updated', exact: true })).toBeVisible();
    expect((await api(`/v1/workspaces/${id}`)).revision).toBe(original.revision);
    await expect.poll(() => ready('当前选区，点击重选')).toBe(true);
    await configure({ mode: 'edit', editText: 'E2E recovered' });
    await fill(panel, 'Recover after storage failure'); await click('发送');
    await expect(page.getByRole('heading', { name: 'E2E recovered', exact: true })).toBeVisible();
    await info.attach('rejected-upload.json', { body: JSON.stringify(failed, null, 2), contentType: 'application/json' });
  });
});
test('COS real: isolated prefix restores after cache deletion', async ({}, info) => {
  test.skip(!process.env.E2E_COS_CONFIG, 'No dedicated COS test configuration provided');
  test.setTimeout(300000);
  await persistenceRoundtrip('cos', info);
});
