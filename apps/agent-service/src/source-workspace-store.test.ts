import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@ui-agent/contracts';
import { SourceWorkspaceStore } from './source-workspace-store';

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
    expect(await tools.inspectElement('source-0')).toMatch(/visibleText: "查 询".+rawTextSegments: \["查 询"\].+compactHtml: <button[^>]+source-0[^>]*>.+<span[^>]+source-1[^>]*>查 询/s);
    expect(await tools.readStyleRule('ui-snapshot-style-0')).toContain('color:red');
    await tools.replaceInElement('source-0', '查 询', '确定');
    expect(await tools.validate()).toContain('校验通过');
    expect(await tools.commit('修改按钮文案')).toBe(1);
    expect(store.html(workspace.workspaceId)).toContain('确定');
    expect(store.get(workspace.workspaceId)).toMatchObject({ revision: 1, canUndo: true, canRedo: false });
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

  it('persists recent source-agent conversation with the workspace', () => {
    const store = createStore();
    const workspace = store.create(snapshot);
    store.recordTurn(workspace.workspaceId, '新增一行订单', {
      kind: 'clarification',
      question: '请提供订单信息'
    });
    store.recordTurn(workspace.workspaceId, '随机生成', {
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
});
