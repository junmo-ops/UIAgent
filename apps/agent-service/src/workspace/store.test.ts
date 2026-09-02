import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type SourceTurnRequest } from '@ui-agent/contracts';
import { SourceWorkspaceStore } from './store';

const roots: string[] = [];

function createStore() {
  const root = mkdtempSync(join(tmpdir(), 'ui-agent-workspace-'));
  roots.push(root);
  return new SourceWorkspaceStore(root);
}

const snapshot = {
  protocolVersion: PROTOCOL_VERSION,
  title: '订单筛选 · 静态副本',
  sourceUrl: 'https://example.test/orders',
  capturedAt: '2026-07-29T10:00:00.000Z',
  html: '<!doctype html><html><body><button data-ui-source-id="source-0" style="color:red"><span data-ui-source-id="source-1" style="font-weight:600">查 询</span></button></body></html>',
  nodeCount: 1,
  selectedSourceId: 'source-0',
  viewport: { width: 1280, height: 800 }
};

function turnRequest(
  instruction: string,
  values: Partial<SourceTurnRequest> = {}
): SourceTurnRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    editSessionId: 'edit-session-1',
    turnId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    instruction,
    ...values
  };
}

describe('SourceWorkspaceStore', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('creates a persistent source workspace and commits validated replacements', async () => {
    const store = createStore();
    const workspace = store.create(snapshot);
    expect(store.html(workspace.workspaceId)).toContain('查 询');
    const tools = store.tools(workspace.workspaceId);
    expect(await tools.searchText('查 询')).toMatch(/命中字符.+button/s);
    expect(await tools.readFile('index.html', 1, 3)).toMatch(/doctype/i);
    expect(await tools.readFile('index.html', 0, 0)).toContain('1:');
    expect(await tools.readFile('index.html', undefined, undefined, 0, 40)).toContain('字符 0-40');
    expect(await tools.readFile('snapshot.css', 1, 5)).toContain('.ui-snapshot-style-');
    expect(await tools.readFile('outline.json', 1, 20)).toContain('"sourceId": "source-0"');
    expect(await tools.listFiles()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'index.html' }),
      expect.objectContaining({ path: 'snapshot.css' }),
      expect.objectContaining({ path: 'outline.json' }),
      expect.objectContaining({ path: 'source-map.json' })
    ]));
    expect(await tools.inspectElement('source-0')).toMatch(/domText: "查 询".+visibilityNote:.+rawTextSegments: \["查 询"\].+compactHtml: <button[^>]+source-0[^>]*>.*<span[^>]+source-1[^>]*>查 询/s);
    expect(await tools.inspectElement('source-0')).toContain('布局上下文:');
    expect(await tools.readStyleRule('ui-snapshot-style-0')).toContain('color:red');
    await tools.replaceInElement('source-0', '查 询', '确定');
    expect(await tools.validate()).toContain('校验通过');
    expect(await tools.commit('修改按钮文案')).toEqual({ revision: 1, changed: true });
    expect(store.html(workspace.workspaceId)).toContain('确定');
    expect(store.get(workspace.workspaceId)).toMatchObject({ revision: 1, canUndo: true, canRedo: false });
  });

  it('returns the existing revision when a verified request needs no source change', async () => {
    const store = createStore();
    const workspace = store.create(snapshot);
    const tools = store.tools(workspace.workspaceId);

    await expect(tools.commit('重复执行相同需求')).rejects.toThrow('Agent 没有对静态源码产生修改');
    expect(await tools.commit('当前副本已满足需求', { allowNoChanges: true })).toEqual({
      revision: 0,
      changed: false
    });
    expect(store.get(workspace.workspaceId)).toMatchObject({ revision: 0, canUndo: false, canRedo: false });
  });

  it('exports the current active revision and excludes trashed workspaces', () => {
    const store = createStore();
    const workspace = store.create(snapshot);
    const exported = store.exportSnapshot(workspace.workspaceId);
    expect(exported).toMatchObject({
      title: snapshot.title,
      sourceUrl: snapshot.sourceUrl,
      viewport: snapshot.viewport
    });
    expect(exported?.html).toContain('data-ui-agent-workspace-styles');
    const second = store.create({ ...snapshot, title: '第二个副本' });
    expect(store.exportActiveSnapshots()).toHaveLength(2);
    store.trash(workspace.workspaceId);
    expect(store.exportSnapshot(workspace.workspaceId)).toBeUndefined();
    expect(store.exportActiveSnapshots()).toEqual([expect.objectContaining({ title: second.title })]);
  });

  it('can disable identity filtering for an internal pilot without changing workspace manifests', () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-agent-workspace-pilot-'));
    roots.push(root);
    const store = new SourceWorkspaceStore(root, { identityIsolation: false });
    const workspace = store.create(snapshot, { userId: 'alice', tenantId: 'company-a' });

    expect(store.list({}, { userId: 'bob', tenantId: 'company-a' }).items)
      .toEqual([expect.objectContaining({ workspaceId: workspace.workspaceId })]);
    expect(store.owns(workspace.workspaceId, { userId: 'another', tenantId: 'company-b' })).toBe(true);
  });

  it('supports revision undo and redo', async () => {
    const store = createStore();
    const workspace = store.create(snapshot);
    const tools = store.tools(workspace.workspaceId);
    await tools.replaceInElement('source-0', '查 询', '确定');
    await tools.commit('修改文案');
    expect(store.undo(workspace.workspaceId)).toMatchObject({ revision: 0, canRedo: true });
    expect(store.html(workspace.workspaceId)).toContain('查 询');
    expect(store.redo(workspace.workspaceId)).toMatchObject({ revision: 1, canUndo: true });
    expect(store.html(workspace.workspaceId)).toContain('确定');
  });

  it('versions snapshot.css together with HTML', async () => {
    const store = createStore();
    const workspace = store.create(snapshot);
    const tools = store.tools(workspace.workspaceId);
    await tools.replaceText('snapshot.css', 'color:red', 'color:blue');
    await tools.commit('修改按钮颜色');
    expect(store.previewHtml(workspace.workspaceId)).toContain('color:blue');

    store.undo(workspace.workspaceId);
    expect(store.previewHtml(workspace.workspaceId)).toContain('color:red');
    store.redo(workspace.workspaceId);
    expect(store.previewHtml(workspace.workspaceId)).toContain('color:blue');
  });

  it('applies atomic patches and can safely append CSS without a text anchor', async () => {
    const store = createStore();
    const workspace = store.create(snapshot);
    const tools = store.tools(workspace.workspaceId);
    await expect(tools.applyPatch('snapshot.css', [{
      kind: 'insert',
      position: 'end',
      text: '\n.gender-select-dropdown{position:absolute;top:100%}'
    }])).resolves.toContain('Patch 成功应用 1 项');
    await tools.commit('增加下拉样式');
    expect(store.previewHtml(workspace.workspaceId)).toContain(
      '.gender-select-dropdown{position:absolute;top:100%}'
    );
  });

  it('persists recent source-agent conversation with the workspace', async () => {
    const store = createStore();
    const workspace = store.create(snapshot);
    const clarificationId = crypto.randomUUID();
    store.recordTurn(workspace.workspaceId, turnRequest('新增一行订单', {
      turnId: clarificationId
    }), {
      kind: 'clarification',
      clarificationId,
      question: '请提供订单信息',
      options: [
        { id: 'manual', label: '手动填写' },
        { id: 'random', label: '随机生成' }
      ],
      allowFreeText: true
    });
    const tools = store.tools(workspace.workspaceId);
    await tools.replaceInElement('source-0', '查 询', '新增订单');
    await tools.commit('已新增随机订单');
    store.recordTurn(workspace.workspaceId, turnRequest('随机生成', {
      replyToClarificationId: clarificationId,
      clarificationOptionId: 'random'
    }), {
      kind: 'completed',
      summary: '已新增随机订单',
      revision: 1,
      modelCalls: 2,
      toolCalls: 1
    });
    expect(store.conversation(workspace.workspaceId)).toEqual([
      { instruction: '新增一行订单', result: '请提供订单信息' },
      { instruction: '随机生成', result: '已新增随机订单' }
    ]);
    const manifest = JSON.parse(readFileSync(
      join(roots.at(-1)!, workspace.workspaceId, 'workspace.json'),
      'utf8'
    )) as { conversation: Array<Record<string, unknown>> };
    expect(manifest.conversation).toEqual(expect.arrayContaining([
      expect.objectContaining({ clarificationId, pending: false }),
      expect.objectContaining({
        replyToClarificationId: clarificationId,
        clarificationOptionId: 'random'
      })
    ]));
    store.undo(workspace.workspaceId);
    expect(store.conversation(workspace.workspaceId)).toEqual([]);
  });

  it('keeps user-visible workspace chat with revisions and hides undone messages', async () => {
    const store = createStore();
    const workspace = store.create(snapshot);
    const turnId = crypto.randomUUID();
    store.appendChat(workspace.workspaceId, {
      id: turnId,
      role: 'user',
      text: '把查询改为确认',
      createdAt: '2026-08-08T00:00:00.000Z',
      revision: 0
    });
    const tools = store.tools(workspace.workspaceId);
    await tools.replaceInElement('source-0', '查 询', '确 认');
    await tools.commit('修改为确认');
    store.recordTurn(workspace.workspaceId, turnRequest('把查询改为确认', { turnId }), {
      kind: 'completed', summary: '已修改为确认', revision: 1, modelCalls: 1, toolCalls: 1
    });
    store.appendChat(workspace.workspaceId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '已修改为确认',
      createdAt: '2026-08-08T00:01:00.000Z',
      revision: 1
    });
    expect(store.chat(workspace.workspaceId).map(entry => entry.text))
      .toEqual(['把查询改为确认', '已修改为确认']);

    store.undo(workspace.workspaceId);
    expect(store.chat(workspace.workspaceId)).toEqual([]);
  });

  it('filters conversation by revision across undo, redo, and a new branch', async () => {
    const store = createStore();
    const workspace = store.create(snapshot);

    const firstTools = store.tools(workspace.workspaceId);
    await firstTools.replaceInElement('source-0', '查 询', '提交');
    await firstTools.commit('修改为提交');
    store.recordTurn(workspace.workspaceId, turnRequest('把查询改成提交'), {
      kind: 'completed', summary: '修改为提交', revision: 1, modelCalls: 1, toolCalls: 1
    });

    const secondTools = store.tools(workspace.workspaceId);
    await secondTools.replaceInElement('source-0', '提交', '确认');
    await secondTools.commit('修改为确认');
    store.recordTurn(workspace.workspaceId, turnRequest('再改成确认'), {
      kind: 'completed', summary: '修改为确认', revision: 2, modelCalls: 1, toolCalls: 1
    });

    store.undo(workspace.workspaceId);
    expect(store.conversation(workspace.workspaceId).map(turn => turn.instruction))
      .toEqual(['把查询改成提交']);

    store.redo(workspace.workspaceId);
    expect(store.conversation(workspace.workspaceId).map(turn => turn.instruction))
      .toEqual(['把查询改成提交', '再改成确认']);

    store.undo(workspace.workspaceId);
    const branchTools = store.tools(workspace.workspaceId);
    await branchTools.replaceInElement('source-0', '提交', '审核');
    await branchTools.commit('修改为审核');
    store.recordTurn(workspace.workspaceId, turnRequest('改成审核'), {
      kind: 'completed', summary: '修改为审核', revision: 2, modelCalls: 1, toolCalls: 1
    });

    expect(store.conversation(workspace.workspaceId).map(turn => turn.instruction))
      .toEqual(['把查询改成提交', '改成审核']);
    expect(() => store.redo(workspace.workspaceId)).toThrow('没有可重做的版本');
  });

  it('rejects unsafe output and paths outside index.html', async () => {
    const store = createStore();
    const workspace = store.create(snapshot);
    const tools = store.tools(workspace.workspaceId);
    await expect(tools.readFile('../secret')).rejects.toThrow('不能访问工作区文件');
    await expect(tools.replaceText(
      'index.html',
      '查 询',
      '<span onclick="steal()">查 询</span>'
    )).rejects.toThrow('不安全内容');
    await tools.rollback();
  });

  it('allows local SVG paint references but rejects external CSS URLs', () => {
    const store = createStore();
    expect(() => store.create({
      ...snapshot,
      html: '<!doctype html><html><body><svg><defs><linearGradient id="paint"></linearGradient></defs><rect fill="url(#paint)"></rect></svg></body></html>'
    })).not.toThrow();
    expect(() => store.create({
      ...snapshot,
      html: '<!doctype html><html><body><div style="background-image:url(https://cdn.example.test/a.png)"></div></body></html>'
    })).toThrow('CSS 外部 url()');
  });

  it('moves an existing element within its original parent without rebuilding it', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: [
        '<!doctype html><html><body>',
        '<main data-ui-source-id="source-10" style="display:flex;flex-direction:column">',
        '<div data-ui-source-id="source-11" class="alert" style="color:#b45309"><strong>风险提示</strong></div>',
        '<section data-ui-source-id="source-12" class="content">订单内容</section>',
        '</main></body></html>'
      ].join('')
    });
    const tools = store.tools(workspace.workspaceId);

    expect(await tools.inspectElement('source-11')).toContain(
      '结构路径: source-10<main> > source-11<div>'
    );
    await expect(tools.moveElement('source-11', 'parentEnd')).resolves.toContain(
      '原始结构和样式保持不变'
    );
    await tools.commit('移动风险提示');

    const html = store.html(workspace.workspaceId)!;
    expect(html.indexOf('订单内容')).toBeLessThan(html.indexOf('风险提示'));
    expect(html).toMatch(/<div[^>]+data-ui-source-id="source-11"[^>]+ui-snapshot-style-1/);
    expect(store.previewHtml(workspace.workspaceId)).toContain(
      '.ui-snapshot-style-1{color:#b45309}'
    );
    expect(html.indexOf('风险提示')).toBeLessThan(html.indexOf('</main>'));
  });

  it('lists, searches, renames, trashes and restores workspaces', () => {
    const store = createStore();
    const first = store.create(snapshot);
    const second = store.create({ ...snapshot, title: '结算页副本', sourceUrl: 'https://example.test/checkout' });

    expect(store.list()).toMatchObject({ total: 2, items: expect.arrayContaining([
      expect.objectContaining({ workspaceId: first.workspaceId }),
      expect.objectContaining({ workspaceId: second.workspaceId })
    ]) });
    expect(store.list({ offset: 1, limit: 1 })).toMatchObject({
      total: 2,
      offset: 1,
      limit: 1,
      items: [expect.objectContaining({ workspaceId: expect.any(String) })]
    });
    expect(store.list({ query: 'checkout' })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ workspaceId: second.workspaceId })]
    });

    expect(store.rename(first.workspaceId, '订单筛选方案')).toMatchObject({ title: '订单筛选方案' });
    expect(store.trash(first.workspaceId).deletedAt).toBeTruthy();
    expect(store.get(first.workspaceId)).toBeUndefined();
    expect(store.list()).toMatchObject({ total: 1 });
    expect(store.list({ status: 'trashed' })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ workspaceId: first.workspaceId })]
    });
    expect(store.restoreWorkspace(first.workspaceId)).not.toHaveProperty('deletedAt');
    expect(store.get(first.workspaceId)).toMatchObject({ title: '订单筛选方案' });
  });

  it('removes a complete element subtree by source id and refreshes indexes', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: [
        '<!doctype html><html><head><style>[data-ui-source-id="source-12"]::after{content:"!"}.shared{color:red}</style></head><body><main data-ui-source-id="source-10">',
        '<section data-ui-source-id="source-11"><span data-ui-source-id="source-12">删除内容</span></section>',
        '<section data-ui-source-id="source-13">保留内容</section>',
        '</main></body></html>'
      ].join('')
    });
    const tools = store.tools(workspace.workspaceId);

    await expect(tools.removeElement('source-11')).resolves.toContain('对应 sourceId 专属样式已同步移除');
    await expect(tools.inspectElement('source-11')).rejects.toThrow('不存在元素');
    await expect(tools.inspectElement('source-12')).rejects.toThrow('不存在元素');
    expect(await tools.inspectElement('source-13')).toContain('保留内容');
    await tools.commit('删除元素');

    const html = store.html(workspace.workspaceId)!;
    expect(html).not.toContain('删除内容');
    expect(html).toContain('保留内容');
    const preview = store.previewHtml(workspace.workspaceId)!;
    expect(preview).not.toContain('[data-ui-source-id="source-12"]::after');
    expect(preview).toContain('.shared{color:red}');
  });

  it('sets escaped text and removes replaced descendant metadata', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: '<!doctype html><html><head><style>[data-ui-source-id="source-12"]::after{content:"!"}</style></head><body><button data-ui-source-id="source-11"><span data-ui-source-id="source-12">旧文案</span></button></body></html>'
    });
    const tools = store.tools(workspace.workspaceId);

    await tools.setElementText('source-11', '<确认 & 继续>');
    await tools.commit('设置文本');

    const html = store.html(workspace.workspaceId)!;
    expect(html).toContain('&lt;确认 &amp; 继续&gt;');
    expect(html).not.toContain('source-12');
    expect(store.previewHtml(workspace.workspaceId)).not.toContain('[data-ui-source-id="source-12"]::after');
  });

  it('updates safe attributes while protecting workspace identity and active behavior', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: '<!doctype html><html><body><button data-ui-source-id="source-11" title="旧标题" disabled>操作</button></body></html>'
    });
    const tools = store.tools(workspace.workspaceId);

    await tools.setElementAttributes('source-11', { title: '新"标题', 'aria-label': '主要操作' }, ['disabled']);
    await expect(tools.setElementAttributes('source-11', { 'data-ui-source-id': 'source-99' }, []))
      .rejects.toThrow('工作区维护');
    await expect(tools.setElementAttributes('source-11', { onclick: 'alert(1)' }, []))
      .rejects.toThrow('DOM 事件属性');
    await tools.commit('更新属性');

    const html = store.html(workspace.workspaceId)!;
    expect(html).toContain('title="新&quot;标题"');
    expect(html).toContain('aria-label="主要操作"');
    expect(html).not.toMatch(/\sdisabled(?:\s|>)/);
  });

  it('inserts static element trees with fresh source ids', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: '<!doctype html><html><body><main data-ui-source-id="source-10"><p data-ui-source-id="source-11">原内容</p></main></body></html>'
    });
    const tools = store.tools(workspace.workspaceId);

    await expect(tools.insertElement(
      'source-10',
      'parentEnd',
      '<section data-ui-source-id="source-10"><strong>新增</strong></section><aside>说明</aside>'
    )).resolves.toContain('source-12, source-14');
    await expect(tools.insertElement('source-10', 'parentEnd', '<script>bad()</script>'))
      .rejects.toThrow('活动或嵌入式标签');
    await tools.commit('插入元素');

    const html = store.html(workspace.workspaceId)!;
    expect(html).toMatch(/source-12[^>]*><strong[^>]+source-13[^>]*>新增/);
    expect(html).toMatch(/aside[^>]+source-14[^>]*>说明/);
  });

  it('wraps, unwraps and reorders element subtrees without rebuilding their contents', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: '<!doctype html><html><body><main data-ui-source-id="source-10"><div data-ui-source-id="source-11"><span data-ui-source-id="source-12">甲</span></div><span data-ui-source-id="source-13">乙</span></main></body></html>'
    });
    const tools = store.tools(workspace.workspaceId);

    await expect(tools.wrapElement('source-13', 'section', { class: 'group' })).resolves.toContain('source-14<section>');
    await tools.unwrapElement('source-11');
    await tools.reorderChildren('source-10', ['source-14', 'source-12']);
    await tools.commit('调整结构');

    const html = store.html(workspace.workspaceId)!;
    expect(html).not.toContain('data-ui-source-id="source-11"');
    expect(html.indexOf('乙')).toBeLessThan(html.indexOf('甲'));
    expect(html).toMatch(/section[^>]+source-14[^>]+class="group"/);
  });

  it('applies DOM operations atomically and rolls all changes back on failure', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: '<!doctype html><html><body><main data-ui-source-id="source-10"><button data-ui-source-id="source-11">旧文案</button></main></body></html>'
    });
    const tools = store.tools(workspace.workspaceId);

    await expect(tools.applyDomOperations([
      { kind: 'setText', sourceId: 'source-11', text: '不应保留' },
      { kind: 'remove', sourceId: 'source-missing' }
    ])).rejects.toThrow('已全部回滚');
    expect(await tools.inspectElement('source-11')).toContain('旧文案');

    await tools.applyDomOperations([
      { kind: 'setText', sourceId: 'source-11', text: '确认' },
      { kind: 'setAttributes', sourceId: 'source-11', set: { 'aria-label': '确认操作' }, remove: [] },
      { kind: 'insert', targetSourceId: 'source-10', position: 'parentEnd', html: '<p>说明</p>' }
    ]);
    await tools.commit('批量修改');

    const html = store.html(workspace.workspaceId)!;
    expect(html).toContain('>确认</button>');
    expect(html).toContain('aria-label="确认操作"');
    expect(html).toContain('>说明</p>');
  });

  it('moves an existing element before or after an explicit target', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: '<!doctype html><html><body><main data-ui-source-id="source-10"><div data-ui-source-id="source-11">甲</div><div data-ui-source-id="source-12">乙</div><div data-ui-source-id="source-13">丙</div></main></body></html>'
    });
    const tools = store.tools(workspace.workspaceId);

    await tools.moveElement('source-13', 'before', 'source-11');
    await tools.commit('移动元素');

    const html = store.html(workspace.workspaceId)!;
    expect(html.indexOf('丙')).toBeLessThan(html.indexOf('甲'));
    expect(html.indexOf('甲')).toBeLessThan(html.indexOf('乙'));
  });

  it('clones a same-style element with fresh source ids and changed content', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: '<!doctype html><html><body><table data-ui-source-id="source-10"><tbody data-ui-source-id="source-11"><tr data-ui-source-id="source-12" class="row" style="height:56px"><td data-ui-source-id="source-13" style="padding:16px">旧订单</td></tr></tbody></table></body></html>'
    });
    const tools = store.tools(workspace.workspaceId);

    await expect(tools.cloneElement(
      'source-12',
      'parentEnd',
      undefined,
      [{ search: '旧订单', replace: '新订单' }]
    )).resolves.toMatch(/完整克隆元素 source-14/);
    await tools.commit('新增同款订单');

    const html = store.html(workspace.workspaceId)!;
    expect(html).toMatch(/<tr[^>]+source-14[^>]+ui-snapshot-style-0/);
    expect(html).toMatch(/<td[^>]+ui-snapshot-style-1[^>]+source-15[^>]*>新订单/);
    expect(store.previewHtml(workspace.workspaceId)).toContain(
      '.ui-snapshot-style-0{height:56px}'
    );
    expect(html.match(/data-ui-source-id="source-12"/g)).toHaveLength(1);
  });

  it('clones source-scoped pseudo styles without guessing ancestor layout changes', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: [
        '<!doctype html><html><head><style>',
        '[data-ui-source-id="source-13"]::after{content:"";position:absolute}',
        '</style></head><body>',
        '<section data-ui-source-id="source-10" style="height:120px">',
        '<div data-ui-source-id="source-11" style="display:flex;flex-wrap:wrap;height:56px">',
        '<button data-ui-source-id="source-12" style="height:56px">充值',
        '<span data-ui-source-id="source-13">去充值</span></button>',
        '</div></section></body></html>'
      ].join('')
    });
    const tools = store.tools(workspace.workspaceId);

    await tools.cloneElement('source-12', 'parentEnd', undefined, []);
    await tools.commit('复制充值模块');

    const preview = store.previewHtml(workspace.workspaceId)!;
    expect(preview).toContain('[data-ui-source-id="source-15"]::after');
    expect(preview).not.toContain('height:auto!important');
  });

  it('rejects malformed table nesting before committing', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: '<!doctype html><html><body><table><tbody><tr><td>订单</td></tr></tbody></table></body></html>'
    });
    const tools = store.tools(workspace.workspaceId);

    await expect(tools.replaceText(
      'index.html',
      '</tbody>',
      '</tr></tbody>'
    )).rejects.toThrow('表格标签结构无效');
    await tools.rollback();
  });

  it('rejects a newly visible element that is fully clipped by its parent', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: '<!doctype html><html><body><div data-ui-source-id="source-10" style="width:48px;height:500px;overflow:hidden;position:relative"><div data-ui-source-id="source-11" style="display:none;position:absolute;left:48px;width:260px;height:100%">历史会话</div></div></body></html>'
    });
    const tools = store.tools(workspace.workspaceId);

    await tools.replaceText('snapshot.css', 'display:none;position:absolute', 'display:flex;position:absolute');
    await expect(tools.validate()).rejects.toThrow(/静态可见性校验失败.+source-11.+source-10/);
    await expect(tools.commit('展开历史会话')).rejects.toThrow('静态可见性校验失败');
    await tools.rollback();
  });

  it('keeps detecting a clipped element committed by an older revision until it is repaired', async () => {
    const store = createStore();
    const workspace = store.create({
      ...snapshot,
      html: '<!doctype html><html><body><div data-ui-source-id="source-10" style="width:48px;height:500px;overflow:hidden;position:relative"><div data-ui-source-id="source-11" style="display:none;position:absolute;left:48px;width:260px;height:100%">历史会话</div></div></body></html>'
    });
    const workspaceDirectory = join(roots.at(-1)!, workspace.workspaceId);
    const cssPath = join(workspaceDirectory, 'snapshot.css');
    const manifestPath = join(workspaceDirectory, 'workspace.json');
    const css = readFileSync(cssPath, 'utf8').replace('display:none', 'display:flex');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(cssPath, css);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, revision: 1, maxRevision: 1 }));

    const tools = store.tools(workspace.workspaceId);
    await tools.replaceInElement('source-11', '历史会话', '历史记录');
    await expect(tools.validate()).rejects.toThrow('静态可见性校验失败');
    await tools.rollback();
  });
});
