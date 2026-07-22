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

describe('DomEngine generic operations', () => {
  afterEach(() => vi.unstubAllGlobals());

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
          anchor: { kind: 'node', nodeId: context.selected.id },
          position: 'insideEnd', resultRef: 'new-row'
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

    engine.applyPlan(plan, false);
    expect([...document.querySelectorAll('tbody > tr')]).toHaveLength(2);
    expect(document.querySelectorAll('tr')[1]?.textContent).toContain('SO002');
    expect(document.querySelectorAll('tr')[1]?.textContent).toContain('随机客户');

    expect(engine.undo()).toBe(true);
    expect([...document.querySelectorAll('tbody > tr')]).toHaveLength(1);
    expect(engine.redo()).toBe(true);
    expect([...document.querySelectorAll('tbody > tr')]).toHaveLength(2);
    expect(document.querySelectorAll('tr')[1]?.textContent).toContain('SO002');
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
          <div class="ant-select"><span class="ant-select-selection-placeholder">请选择渠道</span><input role="combobox"></div>
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
    control.dispatchEvent(new document.defaultView!.Event('click', { bubbles: true }));
    expect(document.querySelectorAll('[data-ui-agent-option]')).toHaveLength(3);
    const prepaid = document.querySelector('[data-ui-agent-option="预付"]') as unknown as HTMLElement;
    prepaid.dispatchEvent(new document.defaultView!.Event('click', { bubbles: true }));
    expect(added.querySelector('.ant-select-selection-item')?.textContent).toBe('预付');
    expect(document.querySelector('[data-ui-agent-static-interaction]')).toBeNull();
  });
});
