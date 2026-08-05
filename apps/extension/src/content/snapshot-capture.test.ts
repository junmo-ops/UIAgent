import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { captureStaticSnapshot } from './snapshot-capture';

function installDom(html: string) {
  const { window } = parseHTML(html);
  for (const name of [
    'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
    'HTMLOptionElement', 'HTMLDetailsElement', 'HTMLButtonElement', 'HTMLFormElement'
  ] as const) {
    vi.stubGlobal(name, window[name]);
  }
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('location', { href: 'https://example.test/orders' });
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('getComputedStyle', (element: HTMLElement, pseudo?: string) => ({
    backgroundColor: element === window.document.body ? 'rgb(245, 245, 245)' : '',
    getPropertyValue: (property: string) => {
      if (pseudo === '::before' && element.classList.contains('modal-centered')) {
        const values: Record<string, string> = {
          content: '""', display: 'inline-block', height: '800px', 'vertical-align': 'middle'
        };
        return values[property] ?? '';
      }
      return element.style.getPropertyValue(property);
    }
  }));
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 600, height: 300, top: 0, right: 600, bottom: 300, left: 0,
    toJSON: () => ({})
  });
  return window.document;
}

describe('captureStaticSnapshot', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('freezes live form state and removes active behavior and external resources', () => {
    const document = installDom(`<!doctype html><html><head><title>订单页</title></head><body>
      <section id="filters" onclick="submitOrder()" data-ui-agent-action="toggle" data-ui-agent-targets="source-9" style="display:flex;gap:12px;cursor:url(data:image/png;base64,eA==),url(https://cdn.example.test/cursor.cur),auto">
        <form action="https://api.example.test/submit">
          <input value="旧值">
          <textarea>旧备注</textarea>
          <select><option>草稿</option><option selected>完成</option></select>
          <button onclick="submitOrder()">查询</button>
        </form>
        <a href="https://example.test/detail">详情</a>
        <img src="https://cdn.example.test/logo.png">
        <style>@import "https://cdn.example.test/theme.css"; .x { color: red; }</style>
        <link rel="stylesheet" href="https://cdn.example.test/theme.css">
        <meta http-equiv="refresh" content="1;url=https://example.test">
        <template><script>hidden()</script><div>模板内容</div></template>
        <!-- <script>commentOnly()</script> -->
        <iframe src="https://example.test/frame"></iframe>
        <script>submitOrder()</script>
      </section>
    </body></html>`);
    const root = document.querySelector('#filters') as unknown as HTMLElement;
    const input = root.querySelector('input') as unknown as HTMLInputElement;
    const textarea = root.querySelector('textarea') as unknown as HTMLTextAreaElement;
    input.value = '当前值';
    textarea.value = '当前备注';

    const snapshot = captureStaticSnapshot(root);

    expect(snapshot.title).toBe('订单页 · 静态快照');
    expect(snapshot.sourceUrl).toBe('https://example.test/orders');
    expect(snapshot.nodeCount).toBeGreaterThan(5);
    expect(snapshot.selectedSourceId).toBe('source-0');
    expect(snapshot.html).toContain('data-ui-source-id="source-0"');
    expect(snapshot.html).toContain('value="当前值"');
    expect(snapshot.html).toContain('当前备注');
    expect(snapshot.html).toContain('display:flex');
    expect(snapshot.html).not.toContain('cursor:url');
    expect(snapshot.html).not.toMatch(/<script|<iframe|<link|<template|<!--/i);
    expect(snapshot.html.match(/<style\b/gi)).toHaveLength(1);
    expect(snapshot.html).not.toContain('@import');
    expect(snapshot.html).not.toMatch(/\sonclick=/i);
    expect(snapshot.html).not.toMatch(/\ssrc="https?:/i);
    expect(snapshot.html).not.toMatch(/\saction=/i);
    expect(snapshot.html).not.toMatch(/\shttp-equiv=/i);
    expect(snapshot.html).not.toContain('data-ui-agent-action');
  });

  it('captures the current page body as a valid editable root and removes editor overlays', () => {
    const document = installDom(`<!doctype html><html><head><title>完整订单页</title></head><body style="margin:0">
      <main><button>查询</button><table><tbody><tr><td>ORD-001</td></tr></tbody></table></main>
      <div data-ui-agent-overlay="true">选区框</div>
    </body></html>`);

    const snapshot = captureStaticSnapshot(document.body as unknown as HTMLElement);

    expect(snapshot.html).toContain('<div');
    expect(snapshot.html).toContain('data-ui-source-id="source-0"');
    expect(snapshot.html).toContain('ORD-001');
    expect(snapshot.html).not.toContain('<body style=');
    expect(snapshot.html).not.toContain('选区框');
    expect(snapshot.html).not.toContain('data-ui-agent-overlay');
  });

  it('preserves fixed overlay offsets so an open modal remains visible', () => {
    const document = installDom(`<!doctype html><html><head><title>弹窗页面</title></head><body>
      <main>页面内容</main>
      <div class="modal-centered" style="position:fixed;inset:0;top:0;right:0;bottom:0;left:0;z-index:1000">
        <div role="dialog">当前打开的弹窗</div>
      </div>
    </body></html>`);

    const snapshot = captureStaticSnapshot(document.body as unknown as HTMLElement);

    expect(snapshot.html).toContain('position:fixed');
    expect(snapshot.html).toContain('inset:0');
    expect(snapshot.html).toContain('top:0');
    expect(snapshot.html).toContain('right:0');
    expect(snapshot.html).toContain('bottom:0');
    expect(snapshot.html).toContain('left:0');
    expect(snapshot.html).toContain('当前打开的弹窗');
    expect(snapshot.html).toContain('[data-ui-source-id="source-2"]::before{content:""');
    expect(snapshot.html).toContain('display:inline-block');
    expect(snapshot.html).toContain('vertical-align:middle');
  });

  it('freezes the capture viewport without adding a layout-changing page gutter', () => {
    const document = installDom(`<!doctype html><html><head><title>跨电脑页面</title></head><body>
      <main style='font-family:"PingFang SC,Microsoft YaHei,Arial,sans-serif"'>内容</main>
      <span id="single-line" style="display:block;font-size:14px;white-space:normal">3.0指引</span>
    </body></html>`);
    const singleLine = document.querySelector('#single-line') as unknown as HTMLElement;
    singleLine.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 48, height: 19, top: 0, right: 48, bottom: 19, left: 0,
      toJSON: () => ({})
    });

    const snapshot = captureStaticSnapshot(document.body as unknown as HTMLElement);

    expect(snapshot.html).toContain('width:100%;min-width:1280px;min-height:800px');
    expect(snapshot.html).toContain('body{padding:0');
    expect(snapshot.html).not.toContain('width:max-content');
    expect(snapshot.html).toContain('margin:0 auto;transform:translateZ(0)');
    expect(snapshot.html).toContain('font-family:PingFang SC,Microsoft YaHei,Arial,sans-serif');
    expect(snapshot.html).toMatch(/id="single-line"[^>]+white-space:nowrap/);
  });
});
