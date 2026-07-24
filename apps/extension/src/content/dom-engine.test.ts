import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { PROTOCOL_VERSION, type ChangePlan } from '@ui-agent/contracts';
import { DomEngine } from './dom-engine';

function installDom(html: string) {
  const { window } = parseHTML(html);
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', window.HTMLInputElement);
  vi.stubGlobal('HTMLTextAreaElement', window.HTMLTextAreaElement);
  vi.stubGlobal('location', { href: 'http://127.0.0.1/orders' });
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('getComputedStyle', () => new Proxy({}, { get: () => '' }));
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 100, height: 32, top: 0, right: 100, bottom: 32, left: 0,
    toJSON: () => ({})
  });
  return window.document;
}

function findTreeIdByText(
  node: ReturnType<DomEngine['context']>['selectedTree'],
  text: string,
  tag?: string
): string | undefined {
  const subtreeText = [node.text, ...node.children.map(child => child.text)].join(' ');
  if ((!tag || node.tag === tag) && subtreeText.includes(text)) return node.id;
  for (const child of node.children) {
    const found = findTreeIdByText(child, text, tag);
    if (found) return found;
  }
  return undefined;
}

describe('DomEngine generic operations', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds a minimal base context and adds requested scopes progressively', () => {
    const document = installDom(`<!doctype html><html><body>
      <div class="actions"><button data-ui-component="query-button"><span>查询</span></button><button>重置</button></div>
    </body></html>`);
    const engine = new DomEngine();
    const button = document.querySelector('[data-ui-component="query-button"]') as unknown as HTMLElement;
    engine.select(button);

    const base = engine.context([]);
    expect(base.contextScopes).toEqual([]);
    expect(base.selectedTree.tag).toBe('button');
    expect(base.selectedTree.children[0]?.text).toBe('查询');
    expect(base.siblings).toEqual([]);
    expect(base.visibleStyle).toEqual({});
    expect(base.reusableTrees).toEqual([]);
    expect(base.elementFacts).toBeUndefined();
    expect(JSON.stringify(base).length).toBeLessThan(JSON.stringify(engine.context()).length);

    const enriched = engine.context(['siblings', 'visibleStyles']);
    expect(enriched.contextScopes).toEqual(['siblings', 'visibleStyles']);
    expect(enriched.siblings).toHaveLength(1);
    expect(enriched.visibleStyle).toHaveProperty('display');
    expect(enriched.elementFacts).toBeUndefined();

    const structural = engine.context(['siblings', 'elementFacts']);
    expect(structural.siblings).toEqual([]);
    expect(structural.elementFacts?.length).toBeGreaterThan(1);
  });

  it('clones a table row, edits descendants through a result reference, and supports undo/redo', () => {
    const document = installDom(`<!doctype html><html><head><title>订单</title></head><body>
      <div class="table-wrapper"><table><tbody><tr class="order-row"><td><a href="#old">SO001</a></td><td>旧客户</td><td>¥ 100.00</td></tr></tbody></table></div>
    </body></html>`);
    const engine = new DomEngine();
    const tableContainer = document.querySelector('.table-wrapper') as unknown as HTMLElement;
    const context = engine.select(tableContainer);
    expect(context.reusableTrees[0]?.tag).toBe('tr');
    const templateRowId = context.reusableTrees[0]!.id;
    const plan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION,
      planId: 'clone-order-row',
      selectionVersion: context.selectionVersion,
      pageRevision: context.pageRevision,
      summary: '复制订单行并填写随机内容',
      requiresConfirmation: false,
      operations: [
        {
          operationId: 'clone', type: 'cloneSubtree',
          source: { kind: 'node', nodeId: templateRowId },
          anchor: { kind: 'node', nodeId: templateRowId },
          position: 'after', resultRef: 'new-row'
        },
        {
          operationId: 'order-id', type: 'updateContent',
          target: { kind: 'result', resultRef: 'new-row', path: [0, 0] }, text: 'SO002'
        },
        {
          operationId: 'customer', type: 'updateContent',
          target: { kind: 'result', resultRef: 'new-row', path: [1] }, text: '随机客户'
        }
      ]
    };

    const receipt = engine.applyPlan(plan, false);
    expect(receipt.operations.every(operation => operation.status === 'applied' && operation.verified)).toBe(true);
    expect([...document.querySelectorAll('tbody > tr')]).toHaveLength(2);
    expect(document.querySelectorAll('tr')[1]?.textContent).toContain('SO002');
    expect(document.querySelectorAll('tr')[1]?.textContent).toContain('随机客户');

    expect(engine.undo()).toBe(true);
    expect([...document.querySelectorAll('tbody > tr')]).toHaveLength(1);
    expect(engine.redo()).toBe(true);
    expect([...document.querySelectorAll('tbody > tr')]).toHaveLength(2);
    expect(document.querySelectorAll('tr')[1]?.textContent).toContain('SO002');
  });

  it('inserts a cloned table row at the first position through an exact sibling anchor', () => {
    const document = installDom(`<!doctype html><html><body>
      <div data-testid="table"><table><tbody>
        <tr><td>第一行</td></tr><tr><td>最后一行</td></tr>
      </tbody></table></div>
    </body></html>`);
    const engine = new DomEngine();
    const wrapper = document.querySelector('[data-testid="table"]') as unknown as HTMLElement;
    const context = engine.select(wrapper);
    const lastRow = context.reusableTrees[0]!;
    const firstRowId = findTreeIdByText(context.selectedTree, '第一行', 'tr')!;
    const plan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'clone-to-first',
      selectionVersion: context.selectionVersion, pageRevision: context.pageRevision,
      summary: '复制最后一行到第一行', requiresConfirmation: false,
      operations: [{
        operationId: 'clone', type: 'cloneSubtree',
        source: { kind: 'node', nodeId: lastRow.id },
        anchor: { kind: 'node', nodeId: firstRowId },
        position: 'before', resultRef: 'first-row'
      }, {
        operationId: 'content', type: 'updateContent',
        target: { kind: 'result', resultRef: 'first-row', path: [0] },
        text: '新增首行'
      }]
    };

    const receipt = engine.applyPlan(plan, false);
    expect(receipt.success).toBe(true);
    expect(receipt.operations[0]).toMatchObject({ verified: true });
    expect(document.querySelector('tbody > tr:first-child')?.textContent).toBe('新增首行');
  });

  it('rejects an invalid structural placement instead of silently moving the clone elsewhere', () => {
    const document = installDom('<!doctype html><html><body><div data-testid="table"><table><tbody><tr><td>模板</td></tr></tbody></table></div></body></html>');
    const engine = new DomEngine();
    const wrapper = document.querySelector('[data-testid="table"]') as unknown as HTMLElement;
    const context = engine.select(wrapper);
    const templateRowId = context.reusableTrees[0]!.id;
    const plan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'invalid-placement',
      selectionVersion: context.selectionVersion, pageRevision: context.pageRevision,
      summary: '无效结构位置', requiresConfirmation: false,
      operations: [{
        operationId: 'clone', type: 'cloneSubtree',
        source: { kind: 'node', nodeId: templateRowId },
        anchor: { kind: 'node', nodeId: context.selected.id },
        position: 'insideStart', resultRef: 'copy'
      }]
    };

    const receipt = engine.applyPlan(plan, false);
    expect(receipt.success).toBe(false);
    expect(receipt.error).toMatch(/需要重新规划合法锚点/);
    expect(document.querySelectorAll('tbody > tr')).toHaveLength(1);
  });

  it('removes executable markup from a cloned subtree', () => {
    const document = installDom(`<!doctype html><html><body><div><section onclick="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">文本</a></section></div></body></html>`);
    const engine = new DomEngine();
    const source = document.querySelector('section') as unknown as HTMLElement;
    const context = engine.select(source);
    const plan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'safe-clone',
      selectionVersion: context.selectionVersion, pageRevision: context.pageRevision,
      summary: '安全复制', requiresConfirmation: false,
      operations: [{
        operationId: 'clone', type: 'cloneSubtree',
        source: { kind: 'node', nodeId: context.selected.id },
        anchor: { kind: 'node', nodeId: context.selected.id },
        position: 'after', resultRef: 'copy'
      }]
    };

    engine.applyPlan(plan, false);
    const clone = document.querySelectorAll('section')[1]!;
    expect(clone.hasAttribute('onclick')).toBe(false);
    expect(clone.querySelector('script')).toBeNull();
    expect(clone.querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  it('keeps a disabled selection overlay hidden after viewport refresh without reverting page changes', () => {
    const document = installDom('<!doctype html><html><body><button>查询</button></body></html>');
    const engine = new DomEngine();
    const button = document.querySelector('button') as unknown as HTMLElement;
    engine.select(button);
    const overlay = document.querySelector('[data-ui-agent-overlay]') as unknown as HTMLElement;
    expect(overlay.style.display).toBe('block');
    engine.disableOverlay();
    engine.refreshOverlay();
    expect(overlay.style.display).toBe('none');
    expect(document.querySelector('button')?.textContent).toBe('查询');

    engine.enableOverlay();
    engine.preview(button);
    expect(overlay.style.display).toBe('block');
  });

  it('clones a nearby semantic form-field template before falling back to a native select', () => {
    const document = installDom(`<!doctype html><html><body><form><div data-testid="row">
      <div class="grid-column" data-ui-component="form-field-select">
        <div class="ant-form-item"><div class="ant-form-item-label"><label>订单渠道</label></div>
          <div class="ant-select css-var-root ant-select-css-var css-dev-only-do-not-override-test"><span class="ant-select-selection-placeholder">请选择渠道</span><input role="combobox"></div>
        </div>
      </div>
    </div></form></body></html>`);
    const engine = new DomEngine();
    const row = document.querySelector('[data-testid="row"]') as unknown as HTMLElement;
    const context = engine.select(row);
    const addSelectPlan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'add-payment-select',
      selectionVersion: context.selectionVersion, pageRevision: context.pageRevision,
      summary: '新增付款方式', requiresConfirmation: false,
      operations: [{
        operationId: 'add', type: 'addComponent', component: 'select',
        anchor: { kind: 'node', nodeId: context.selected.id }, position: 'after',
        props: { label: '付款方式', placeholder: '请选择付款方式', options: ['月结', '预付', '货到付款'] }
      }]
    };

    engine.applyPlan(addSelectPlan, false);
    const added = document.querySelector('[data-ui-agent-added]') as unknown as HTMLElement;
    expect(added.className).toBe('grid-column');
    expect(added.querySelector('label')?.textContent).toBe('付款方式');
    expect(added.querySelector('.ant-select-selection-placeholder')?.textContent).toBe('请选择付款方式');
    expect(added.getAttribute('data-ui-agent-options')).toContain('货到付款');
    expect(document.querySelectorAll('select')).toHaveLength(0);

    const control = added.querySelector('.ant-select') as unknown as HTMLElement;
    control.getBoundingClientRect = () => ({
      x: 120, y: 200, width: 240, height: 32, top: 200, right: 360, bottom: 232, left: 120,
      toJSON: () => ({})
    });
    control.dispatchEvent(new document.defaultView!.Event('click', { bubbles: true }));
    expect(document.querySelectorAll('[data-ui-agent-option]')).toHaveLength(3);
    const clickPanel = document.querySelector('[data-ui-agent-static-interaction]') as unknown as HTMLElement;
    expect(clickPanel.style.left).toBe('120px');
    expect(clickPanel.style.top).toBe('236px');
    expect(clickPanel.classList.contains('css-var-root')).toBe(true);
    expect(clickPanel.classList.contains('ant-select-css-var')).toBe(true);
    expect(clickPanel.classList.contains('css-dev-only-do-not-override-test')).toBe(true);
    expect(clickPanel.querySelector('.rc-virtual-list-holder-inner')).not.toBeNull();
    expect(clickPanel.querySelector('.ant-select-item-option-content')?.textContent).toBe('月结');
    const prepaid = document.querySelector('[data-ui-agent-option="预付"]') as unknown as HTMLElement;
    prepaid.dispatchEvent(new document.defaultView!.Event('click', { bubbles: true }));
    expect(added.querySelector('.ant-select-selection-item')?.textContent).toBe('预付');
    expect(document.querySelector('[data-ui-agent-static-interaction]')).toBeNull();

    const openPlan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'open-payment-select',
      selectionVersion: context.selectionVersion, pageRevision: 1,
      summary: '展开付款方式', requiresConfirmation: false,
      operations: [{
        operationId: 'open', type: 'setVisualState',
        target: { kind: 'node', nodeId: added.getAttribute('data-ui-agent-id')! },
        state: 'open', value: true, options: ['月结', '预付', '货到付款']
      }]
    };
    const openReceipt = engine.applyPlan(openPlan, false);
    expect(openReceipt.operations[0]).toMatchObject({ status: 'applied', verified: true });
    const explicitPanel = document.querySelector('[data-ui-agent-static-interaction]') as unknown as HTMLElement;
    expect(explicitPanel.style.left).toBe('120px');
    expect(explicitPanel.style.top).toBe('236px');
    expect(control.getAttribute('aria-expanded')).toBe('true');

    control.getBoundingClientRect = () => ({
      x: 160, y: 260, width: 240, height: 32, top: 260, right: 400, bottom: 292, left: 160,
      toJSON: () => ({})
    });
    document.defaultView!.dispatchEvent(new document.defaultView!.Event('scroll'));
    expect(explicitPanel.style.left).toBe('160px');
    expect(explicitPanel.style.top).toBe('296px');
    engine.undo();
    expect(document.querySelector('[data-ui-agent-static-interaction]')).toBeNull();
  });

  it('updates a cloned Ant Design select placeholder even when the template is the selected control', () => {
    const document = installDom(`<!doctype html><html><body><div class="filter-row">
      <div class="ant-select" data-ui-component="status-select">
        <div class="ant-select-selector"><span class="ant-select-selection-placeholder">订单状态</span><input role="combobox"></div>
      </div><button>查询</button>
    </div></body></html>`);
    const engine = new DomEngine();
    const select = document.querySelector('[data-ui-component="status-select"]') as unknown as HTMLElement;
    const context = engine.select(select);
    const plan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'clone-filter-select',
      selectionVersion: context.selectionVersion, pageRevision: context.pageRevision,
      summary: '新增订单来源', requiresConfirmation: false,
      operations: [{
        operationId: 'add', type: 'addComponent', component: 'select',
        anchor: { kind: 'node', nodeId: context.selected.id }, position: 'after',
        resultRef: 'source', props: {
          label: '订单来源', placeholder: '请选择订单来源',
          options: ['线上商城', '企业直销', '合作伙伴']
        }
      }]
    };

    engine.applyPlan(plan, false);
    const added = document.querySelector('[data-ui-agent-added]') as unknown as HTMLElement;
    expect(added.querySelector('.ant-select-selection-placeholder')?.textContent).toBe('请选择订单来源');
    expect(added.querySelector('input')?.getAttribute('placeholder')).toBe('请选择订单来源');
  });

  it('renders semantic danger buttons, labeled tags and warning alerts', () => {
    const document = installDom('<!doctype html><html><body><main><div data-testid="anchor">锚点</div></main></body></html>');
    const engine = new DomEngine();
    const anchor = document.querySelector('[data-testid="anchor"]') as unknown as HTMLElement;
    const context = engine.select(anchor);
    const plan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'semantic-components',
      selectionVersion: context.selectionVersion, pageRevision: context.pageRevision,
      summary: '新增语义组件', requiresConfirmation: false,
      operations: [
        {
          operationId: 'danger', type: 'addComponent', component: 'button',
          anchor: { kind: 'node', nodeId: context.selected.id }, position: 'after',
          props: { text: '批量驳回', variant: 'danger' }
        },
        {
          operationId: 'tag', type: 'addComponent', component: 'tag',
          anchor: { kind: 'node', nodeId: context.selected.id }, position: 'after',
          props: { label: '风险等级', text: '高风险', variant: 'danger' }
        },
        {
          operationId: 'alert', type: 'addComponent', component: 'alert',
          anchor: { kind: 'node', nodeId: context.selected.id }, position: 'after',
          props: { text: '需要补充合同', variant: 'warning' }
        }
      ]
    };

    const receipt = engine.applyPlan(plan, false);
    expect(receipt.operations.every(operation => operation.verified)).toBe(true);
    const danger = [...document.querySelectorAll<HTMLElement>('[data-ui-agent-added]')]
      .find(node => node.textContent === '批量驳回')!;
    expect(danger.style.backgroundColor).toBe('#ff4d4f');
    const tagField = [...document.querySelectorAll<HTMLElement>('[data-ui-agent-added]')]
      .find(node => node.textContent?.includes('风险等级'))!;
    expect(tagField.querySelector('.ant-tag')?.textContent).toBe('高风险');
    expect((tagField.querySelector('.ant-tag') as HTMLElement).style.backgroundColor).toBe('#fff1f0');
    const alert = document.querySelector('.ant-alert-warning');
    expect(alert?.querySelector('.ant-alert-message')?.textContent).toBe('需要补充合同');
  });

  it('keeps a relative insertion on the same row when a fixed grid exactly fits its current children', () => {
    const document = installDom(`<!doctype html><html><body>
      <div data-testid="summary" style="display:grid">
        <div>当前状态</div><div>订单金额</div><div>创建时间</div>
      </div>
    </body></html>`);
    const summary = document.querySelector('[data-testid="summary"]') as unknown as HTMLElement;
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => new Proxy({
      display: element === summary ? 'grid' : 'block',
      gridTemplateColumns: element === summary ? '100px 100px 100px' : 'none'
    }, { get: (target, property: string) => property in target ? target[property as keyof typeof target] : '' }));
    const engine = new DomEngine();
    const context = engine.select(summary);
    const createdAtId = context.selectedTree.children[2]!.id;
    const plan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'summary-risk',
      selectionVersion: context.selectionVersion, pageRevision: context.pageRevision,
      summary: '在创建时间右侧新增风险等级', requiresConfirmation: false,
      operations: [
        {
          operationId: 'layout', type: 'updateStyle',
          target: { kind: 'node', nodeId: context.selected.id },
          styles: { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }
        },
        {
          operationId: 'risk', type: 'addComponent', component: 'tag',
          anchor: { kind: 'node', nodeId: createdAtId }, position: 'after',
          props: { label: '风险等级', text: '高风险', variant: 'danger' }
        }
      ]
    };

    engine.applyPlan(plan, false);
    expect(summary.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    expect(summary.children[3]?.textContent).toContain('风险等级');
    expect(engine.undo()).toBe(true);
    expect(summary.style.gridTemplateColumns).toBe('');
    expect(summary.children).toHaveLength(3);
  });

  it('applies selected state to the requested option rather than only the group root', () => {
    const document = installDom('<!doctype html><html><body><div data-testid="row"></div></body></html>');
    const engine = new DomEngine();
    const row = document.querySelector('[data-testid="row"]') as unknown as HTMLElement;
    const context = engine.select(row);
    const plan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'selected-option',
      selectionVersion: context.selectionVersion, pageRevision: context.pageRevision,
      summary: '突出电子普票', requiresConfirmation: false,
      operations: [{
        operationId: 'add', type: 'addComponent', component: 'radioGroup',
        anchor: { kind: 'node', nodeId: context.selected.id }, position: 'insideEnd',
        resultRef: 'invoice', props: { options: ['无需发票', '电子普票', '增值税专票'] }
      }, {
        operationId: 'selected', type: 'setVisualState',
        target: { kind: 'result', resultRef: 'invoice', path: [] },
        state: 'selected', value: true, options: ['电子普票']
      }]
    };

    const receipt = engine.applyPlan(plan, false);
    expect(receipt.operations[1]).toMatchObject({ verified: true });
    const selected = [...document.querySelectorAll('label')]
      .find(label => label.textContent?.trim() === '电子普票')!;
    expect(selected.querySelector('input')?.checked).toBe(true);
    expect(selected.getAttribute('aria-selected')).toBe('true');
  });

  it('returns an execution observation after the selected element itself is removed', () => {
    const document = installDom('<!doctype html><html><body><main><button>删除我</button></main></body></html>');
    const engine = new DomEngine();
    const button = document.querySelector('button') as unknown as HTMLElement;
    const context = engine.select(button);
    const removePlan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'remove-selected',
      selectionVersion: context.selectionVersion, pageRevision: context.pageRevision,
      summary: '删除按钮', requiresConfirmation: true,
      operations: [{ operationId: 'remove', type: 'removeElement', target: { kind: 'node', nodeId: context.selected.id } }]
    };
    const receipt = engine.applyPlan(removePlan, true);
    expect(receipt.success).toBe(true);
    expect(document.querySelector('button')).toBeNull();
    expect(engine.context()).toMatchObject({ selectionVersion: context.selectionVersion, pageRevision: 1 });
  });

  it('rolls back earlier operations and returns a structured failed receipt when a later operation fails', () => {
    const document = installDom('<!doctype html><html><body><main><button>查询</button></main></body></html>');
    const engine = new DomEngine();
    const button = document.querySelector('button') as unknown as HTMLElement;
    const context = engine.select(button);
    const failingPlan: ChangePlan = {
      protocolVersion: PROTOCOL_VERSION, planId: 'rollback-plan',
      selectionVersion: context.selectionVersion, pageRevision: context.pageRevision,
      summary: '新增后触发无效路径', requiresConfirmation: false,
      operations: [
        {
          operationId: 'add', type: 'addComponent', component: 'button',
          anchor: { kind: 'node', nodeId: context.selected.id }, position: 'after', resultRef: 'new-button', props: { text: '新增' }
        },
        {
          operationId: 'invalid-edit', type: 'updateContent',
          target: { kind: 'result', resultRef: 'new-button', path: [99] }, text: '不会成功'
        }
      ]
    };
    const receipt = engine.applyPlan(failingPlan, false);
    expect(receipt).toMatchObject({
      success: false, pageRevision: 0, appliedOperationIds: [],
      operations: [
        { operationId: 'add', status: 'rolledBack', verified: false },
        { operationId: 'invalid-edit', status: 'failed', verified: false, errorCode: 'EXECUTION_ERROR' }
      ]
    });
    expect([...document.querySelectorAll('button')]).toHaveLength(1);
    expect(engine.historyState().canUndo).toBe(false);
  });
});
