import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cases } from './real-cases.mjs';
import { demoCases } from './demo-cases.mjs';
import { complexCases, complexPages } from './complex-cases.mjs';
import { withPanel, state, fill, nativeClick, serviceUrl } from './harness.mjs';
const suite = process.env.REAL_SUITE === 'demo' ? demoCases : process.env.REAL_SUITE === 'complex' ? complexCases : cases;
const selected = process.env.REAL_CASES ? suite.filter(c => process.env.REAL_CASES.split(',').includes(c.id)) : process.env.REAL_ALL === '1' || ['complex','demo'].includes(process.env.REAL_SUITE) ? suite : suite.filter(c => c.pilot);
if (!selected.length) throw new Error('No matching real-model scenarios');
for (const item of selected) test(`${item.id} ${item.category} ${item.layout}`, async ({}, info) => withPanel(item.layout, info, async ({ page, panel, click, ready }) => {
  const evidence = { case: item, automated: 'running', semanticReview: 'pending', provenance: { runId: process.env.REAL_RUN_ID, gitHead: execFileSync('git', ['rev-parse','HEAD'], { encoding:'utf8' }).trim(), caseSha256: createHash('sha256').update(JSON.stringify(item)).digest('hex'), runtimeSha256: createHash('sha256').update(readFileSync(new URL('../../packages/agent-runtime/vendor/ui-agent-runtime/index.js', import.meta.url))).digest('hex'), node: process.version }, turns: [], model: (await state()).model };
  if (complexPages[item.layout]) evidence.provenance.fixtureSha256 = createHash('sha256').update(complexPages[item.layout]).digest('hex');
  if (item.assetFiles) evidence.provenance.assetSha256 = Object.fromEntries(item.assetFiles.map(path => [path, createHash('sha256').update(readFileSync(new URL('../../' + path, import.meta.url))).digest('hex')]));
  if (item.viewport) await page.setViewportSize(item.viewport);
  await page.screenshot({ path: info.outputPath('source-before-capture.png'), fullPage: true });
  await click('进入副本编辑'); await page.waitForURL(/\/workspaces\/[^/]+\/preview/);
  const id = new URL(page.url()).pathname.split('/')[2];
  const revision = async () => (await (await fetch(`${serviceUrl}/v1/workspaces/${id}`)).json()).revision;
  if (item.select) { await click('选择区域'); await (item.selectionCss ? page.locator(item.selectionCss) : page.getByRole('heading', { name: item.selection || 'E2E target', exact: true })).click(); await expect.poll(() => ready('当前选区，点击重选')).toBe(true); }
  const buttonSnapshot = async () => page.locator('[data-ui-agent-snapshot-stage]').evaluate((root, selector) => {
    const target = root.querySelector(selector), style = getComputedStyle(target), r = target.getBoundingClientRect();
    const copy = root.cloneNode(true); copy.querySelector(selector).textContent = '[TARGET]';
    return { otherText:copy.textContent, tag:target.tagName, className:target.className,
      style:Object.fromEntries(['color','backgroundColor','fontSize','fontWeight','borderRadius','display','padding'].map(k => [k,style[k]])),
      rect:{x:r.x,y:r.y,width:r.width,height:r.height} };
  }, item.selectionCss);
  const buttonBefore = item.selectionCss ? await buttonSnapshot() : undefined;
  const preserved = [];
  for (const selector of (item.preserveSelectors ?? [])) preserved.push({ selector, text: await page.locator(selector).allTextContents() });
  evidence.preserved = preserved;
  try {
    expect(evidence.model.configuredId, 'Isolated service uses requested model').toBe(process.env.REAL_MODEL_ID || 'default');
    for (const [index, turn] of item.turns.entries()) {
      const before = await revision();
      const beforeDom = await page.locator('[data-ui-agent-snapshot-stage]').evaluate(e => e.outerHTML);
      const beforeGeometry = await captureGeometry(page);
      const previous = await state();
      await page.screenshot({ path: info.outputPath(`turn-${index + 1}-before.png`), fullPage: true });
      let selectedOption;
      const startedAt = Date.now();
      if (turn.chooseClarification) {
        const options = await panel.evaluate(`Array.from(document.querySelectorAll('.clarification-options button:not(:disabled)')).map((b, index) => ({ index, label: b.querySelector('strong')?.textContent, text: b.textContent }))`);
        evidence.optionSelections ??= [];
        const matches = options.filter(option => new RegExp(turn.chooseClarification).test(option.text));
        evidence.optionSelections.push({ options, matches });
        expect(matches, 'Exactly one observed option matches requested placement').toHaveLength(1);
        selectedOption = matches[0];
        await nativeClick(panel, `.clarification-options button:not(:disabled):nth-child(${selectedOption.index + 1})`);
      } else {
        await fill(panel, turn.prompt); await click('发送');
      }
      await expect.poll(() => panel.evaluate(`Boolean(document.querySelector('button[aria-label="停止生成"]'))`), { timeout: 10000 }).toBe(true);
      // Router -> editor handoff can briefly hide the stop button. Require the
      // routed edit to reach a persisted terminal log before observing idle UI.
      await expect.poll(async () => {
        const pending = await state();
        const route = pending.routes.find(r => !previous.routes.some(p => p.turnId === r.turnId));
        if (!route) return false;
        if (route.result.kind !== 'page_edit') return true;
        return pending.logs.some(l => l.request.turnId === route.turnId
          && ['completed', 'clarification', 'failed', 'cancelled'].includes(l.result?.kind));
      }, { timeout: 240000, intervals: [500,1000,2000], message: 'Routed edit reaches terminal result' }).toBe(true);
      await expect.poll(() => panel.evaluate(`Boolean(document.querySelector('button[aria-label="停止生成"]'))`), { timeout: 240000, intervals: [500,1000,2000] }).toBe(false);
      const current = await state();
      const logs = current.logs.filter(l => !previous.logs.some(p => p.id === l.id));
      const routes = current.routes.filter(r => !previous.routes.some(p => p.turnId === r.turnId));
      const dialogue = await panel.evaluate(`document.querySelector('.chat-list').innerText`);
      const record = { beforeDom, beforeGeometry, prompt: turn.prompt, selectedOption, elapsedMs: Date.now() - startedAt, routes, logs, dialogue, beforeRevision: before, afterRevision: await revision(), automatedChecks: [] };
      evidence.turns.push(record);
      await page.screenshot({ path: info.outputPath(`turn-${index + 1}-after.png`), fullPage: true });
      record.dom = await page.locator('[data-ui-agent-snapshot-stage]').evaluate(e => e.outerHTML);
      record.geometry = await captureGeometry(page);
      for (const log of logs) expect(log.model?.name, 'Logged editor model matches selected configuration').toBe(evidence.model.name);
      expect(routes.length, 'Real router response recorded').toBeGreaterThan(0);
      expect(routes.some(r => r.result.kind === 'failed'), dialogue).toBe(false);
      expect(logs.some(l => l.result.kind === 'failed' || l.result.kind === 'cancelled'), dialogue).toBe(false);
      if (turn.expectClarification !== undefined) {
        const count = await panel.evaluate(`document.querySelectorAll('.clarification-options button:not(:disabled)').length`);
        expect(count > 0, dialogue).toBe(turn.expectClarification);
        record.automatedChecks.push(turn.expectClarification ? 'active clarification options shown' : 'no repeated clarification');
      }
      if (selectedOption) {
        expect(routes.some(r => r.replyToClarificationId && r.clarificationOptionId), 'UI submitted clarification ID and option ID').toBe(true);
        expect(record.afterRevision, 'Choice produces a saved edit').toBeGreaterThan(before);
        record.automatedChecks.push('native option click sent both IDs and completed edit');
      }
      if (turn.unchanged) { expect(record.afterRevision).toBe(before); expect(record.dom).toBe(beforeDom); record.automatedChecks.push('revision and page DOM unchanged'); }
      if (turn.expectEdit) expect(record.afterRevision, 'Edit saved').toBeGreaterThan(before);
      if (turn.buttonText) {
        await expect(page.getByRole('button', { name:new RegExp('^'+turn.buttonText.split('').join('\\s*')+'$') })).toHaveCount(1);
        await expect(page.getByRole('button', { name:new RegExp('^'+turn.buttonText.split('').join('\\s*')+'$') })).toBeVisible();
        const target = page.locator(item.selectionCss);
        record.button = await target.evaluate(e => ({text:e.textContent,role:e.getAttribute('role'),tag:e.tagName}));
        expect(record.button.text.replace(/\s/g, '')).toBe(turn.buttonText);
        record.buttonBefore = buttonBefore;
        record.buttonAfter = await buttonSnapshot();
        // Text replacement may naturally change intrinsic width; preserve styling
        // and anchor/height, not a hard-coded width for a different string.
        const withoutWidth = snapshot => ({...snapshot,rect:{...snapshot.rect,width:undefined}});
        expect(withoutWidth(record.buttonAfter)).toEqual(withoutWidth(buttonBefore));
        await page.reload();
        await expect(page.getByRole('button', {name:new RegExp('^'+turn.buttonText.split('').join('\\s*')+'$')})).toBeVisible();
        expect(await revision()).toBe(record.afterRevision);
        record.automatedChecks.push('button name verified; surrounding text, class, anchor, height and style preserved (intrinsic width may change); saved edit survives reload');
        await page.screenshot({path:info.outputPath(`turn-${index+1}-reloaded.png`),fullPage:true});
      }
      if (turn.horizontalOrder) {
        record.viewport = await page.evaluate(() => ({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth}));
        record.horizontalOrder = [];
        for (const target of turn.horizontalOrder) {
          const locator = target.css ? page.locator(target.css) : target.label ? page.getByLabel(target.label, { exact:true }) : page.getByRole(target.role, { name:new RegExp(target.name.split('').join('\\s*')) });
          record.horizontalOrder.push({ target, rect:await locator.boundingBox() });
        }
        for (let i = 1; i < record.horizontalOrder.length; i++) {
          const a = record.horizontalOrder[i-1].rect, b = record.horizontalOrder[i].rect;
          expect(a, 'left reference exists').not.toBeNull(); expect(b, 'right target exists').not.toBeNull();
          expect(b.x + b.width, 'right target fits viewport').toBeLessThanOrEqual(record.viewport.width + 1);
          expect(b.x, 'visual horizontal order').toBeGreaterThanOrEqual(a.x + a.width - 1);
          expect(Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y), 'same-row vertical overlap').toBeGreaterThan(0);
        }
      }
      for (const text of (turn.visibleTexts ?? [])) await expect.poll(() => page.getByText(text, { exact:true }).evaluateAll(nodes => nodes.some(n => n.checkVisibility())), { timeout:10000 }).toBe(true);
      for (const label of (turn.labels ?? [])) await expect(page.getByLabel(label, { exact:true })).toBeVisible();
      for (const label of (turn.absentLabels ?? [])) await expect(page.getByLabel(label, { exact:true })).toHaveCount(0);
      if (turn.headingOrder) {
        record.headingOrder = [];
        for (const title of turn.headingOrder) {
          const target = page.getByRole('heading', { name:title, exact:true });
          await expect(target).toHaveCount(1);
          record.headingOrder.push({ title, rect:await target.boundingBox() });
        }
        for (let j=1;j<record.headingOrder.length;j++) expect(record.headingOrder[j].rect.y).toBeGreaterThan(record.headingOrder[j-1].rect.y);
      }
      if (turn.actions) {
        record.interactions = [];
        await runActions(page, info, turn.actions, record.interactions, `turn-${index+1}-interaction`);
        expect(record.interactions.filter(c => c.outcome === 'failed'), 'Turn interactions').toEqual([]);
      }
      for (const entry of preserved) expect(await page.locator(entry.selector).allTextContents(), entry.selector + ' text preserved').toEqual(entry.text);
      if (turn.text) {
        await expect(page.getByRole('heading', { name: turn.text, exact: true })).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole('heading', { name: 'Other heading', exact: true })).toHaveCount(1);
        await expect(page.getByText('First section', { exact: true })).toHaveCount(1);
        await expect(page.getByText('Second section', { exact: true })).toHaveCount(1);
        record.automatedChecks.push('requested title visible, other heading and paragraphs preserved');
      }
    }
    if (item.placement) {
      const initial = evidence.turns[0].beforeGeometry;
      const card = initial.find(n => n.tag === 'ARTICLE');
      const aside = initial.find(n => n.tag === 'ASIDE');
      evidence.placement = await page.evaluate(({ cardId, asideId }) => {
        const original = document.querySelector(`[data-ui-source-id="${cardId}"]`);
        const neighbor = document.querySelector(`[data-ui-source-id="${asideId}"]`);
        const input = document.querySelector('[data-ui-agent-snapshot-stage] input');
        const rect = e => { const r = e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right }; };
        return { inside: original.contains(input), card:rect(original), aside:rect(neighbor), input:input ? rect(input) : null };
      }, { cardId:card.sourceId, asideId:aside.sourceId });
      const result = evidence.placement;
      expect(result.input, 'Subscription input exists').not.toBeNull();
      expect(result.inside).toBe(item.placement === 'inside');
      if (item.placement === 'outside') expect(result.input.y).toBeGreaterThanOrEqual(result.card.bottom);
      expect(result.input.x).toBeGreaterThanOrEqual(result.card.x - 1);
      expect(result.input.right).toBeLessThanOrEqual(result.card.right + 1);
      for (const key of ['x', 'y', 'width']) expect(Math.abs(result.aside[key] - aside.rect[key]), `neighbor ${key} preserved`).toBeLessThanOrEqual(1);
    }
    evidence.interactions = [];
    await runActions(page, info, item.actions ?? [], evidence.interactions, 'interaction');
    if (item.scrollTarget) {
      const scroller = page.locator(item.scrollTarget);
      evidence.scroll = await scroller.evaluate(e => { e.scrollTop = e.scrollHeight; return { scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight }; });
      await page.screenshot({ path: info.outputPath('scrolled-to-bottom.png'), fullPage: true });
    }
    evidence.automated = 'passed';
    if (evidence.interactions.some(c => c.outcome === 'failed')) throw new Error('One or more browser interaction checks failed; see evaluation.json');
  } catch (error) { evidence.automated = 'failed'; evidence.failure = String(error); throw error; }
  finally {
    const finalState = await state().catch(error => ({ error: String(error) }));
    evidence.finalState = { ...finalState, logs: finalState.logs?.filter(l => l.sourceWorkspaceId === id || l.request.context?.workspaceId === id), routes: finalState.routes?.filter(r => r.workspaceId === id) };
    const output = JSON.stringify(evidence, null, 2);
    writeFileSync(info.outputPath('evaluation.json'), output);
    await info.attach('evaluation.json', { body: output, contentType: 'application/json' });
    await info.attach('dialogue.html', { body: await panel.evaluate('document.documentElement.outerHTML').catch(String), contentType: 'text/html' });
  }
}));

async function captureGeometry(page) {
  return page.locator('[data-ui-agent-snapshot-stage]').evaluate(e => [e, ...e.querySelectorAll('main,header,section,article,h1,h2,p,aside,button,input,.columns,.stack,.pair,.scroll-list,.actions')].map(n => {
    const r = n.getBoundingClientRect(), s = getComputedStyle(n);
    return { tag:n.tagName,sourceId:n.getAttribute('data-ui-source-id'),className:n.className,text:n.textContent.slice(0,500),rect:{x:r.x,y:r.y,width:r.width,height:r.height},color:s.color,fontSize:s.fontSize,display:s.display,position:s.position,overflowX:s.overflowX,overflowY:s.overflowY,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth };
  }));
}

async function runActions(page, info, actions, records, prefix) {

    for (const [index, action] of actions.entries()) {
      const check = { action, outcome: 'passed' };
      try {
        // Component libraries may insert visual spacing into short button labels.
        if (action.kind === 'click') {
          const name = new RegExp('^' + Array.from(action.name).map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*') + '$');
          await page.getByRole(action.role, { name }).click({ timeout: 4000 });
        }
        if (action.kind === 'fill') await page.getByLabel(action.label, { exact: true }).fill(action.value, { timeout: 4000 });
        if (action.kind === 'visible') await expect.poll(() => page.getByText(action.text, { exact: true }).evaluateAll(nodes => nodes.some(n => n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))), { timeout: 4000 }).toBe(true);
        if (action.kind === 'hidden') await expect(page.getByText(action.text, { exact: true })).toBeHidden({ timeout: 4000 });
      } catch (error) { check.outcome = 'failed'; check.error = String(error); }
      check.dom = await page.locator('[data-ui-agent-snapshot-stage]').evaluate(e => e.outerHTML);
      records.push(check);
      await page.screenshot({ path: info.outputPath(`${prefix}-${index + 1}.png`), fullPage: true });
    }
}
