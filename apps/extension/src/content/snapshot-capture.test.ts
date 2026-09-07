import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { captureStaticSnapshot } from './snapshot-capture';

let stylePrototype: object | undefined;

function installDom(html: string) {
  const { window } = parseHTML(html);
  // linkedom does not implement browser CSSOM. Individual author-style tests
  // provide sheets explicitly; frozen-style tests do not depend on CSSOM.
  Object.defineProperty(window.document, 'styleSheets', { value: [], configurable: true });
  Object.defineProperty(window.document, 'location', { value: { href: 'https://example.test/orders' } });
  stylePrototype = Object.getPrototypeOf(window.document.body.style);
  Object.defineProperty(stylePrototype!, 'getPropertyPriority', { value: () => '', configurable: true });
  for (const name of [
    'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
    'HTMLOptionElement', 'HTMLDetailsElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLImageElement'
  ] as const) {
    vi.stubGlobal(name, window[name]);
  }
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('location', { href: 'https://example.test/orders' });
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('getComputedStyle', (element: HTMLElement, pseudo?: string) => {
    const values = pseudo === '::before' && element.classList.contains('modal-centered')
      ? { content: '""', display: 'inline-block', height: '800px', 'vertical-align': 'middle' }
      : Object.fromEntries([...element.style].map(property => [property, element.style.getPropertyValue(property)]));
    const properties = Object.keys(values);
    return {
      backgroundColor: element === window.document.body ? 'rgb(245, 245, 245)' : '',
      length: properties.length,
      item: (index: number) => properties[index] ?? '',
      getPropertyValue: (property: string) => values[property] ?? ''
    };
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 600, height: 300, top: 0, right: 600, bottom: 300, left: 0,
    toJSON: () => ({})
  });
  return window.document;
}

describe('captureStaticSnapshot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (stylePrototype) Reflect.deleteProperty(stylePrototype, 'getPropertyPriority');
  });

  it('freezes live form state, removes active behavior, and records external resources', () => {
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

    const snapshot = captureStaticSnapshot(root, true);

    expect(snapshot.title).toBe('订单页 · 静态快照');
    expect(snapshot.sourceUrl).toBe('https://example.test/orders');
    expect(snapshot.nodeCount).toBeGreaterThan(5);
    expect(snapshot.selectedSourceId).toBe('source-0');
    expect(snapshot.html).toContain('data-ui-source-id="source-0"');
    expect(snapshot.html).toContain('value="当前值"');
    expect(snapshot.html).toContain('当前备注');
    expect(snapshot.html).toContain('display:flex');
    expect(snapshot.html).toContain('data-ui-agent-source-rect="0,0,600,300"');
    // linkedom does not serialize rewritten CSSStyleDeclaration values the same
    // way as Chrome. The image resource remains a stable capture contract; CSS
    // URL rewriting is covered by the service-side localization path.
    expect(snapshot.authorStyles?.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://cdn.example.test/logo.png' })
    ]));
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

    const snapshot = captureStaticSnapshot(document.body as unknown as HTMLElement, true);

    expect(snapshot.html).toContain('<div');
    expect(snapshot.html).toContain('data-ui-source-id="source-0"');
    expect(snapshot.html).toContain('ORD-001');
    expect(snapshot.html).not.toContain('<body style=');
    expect(snapshot.html).not.toContain('选区框');
    expect(snapshot.html).not.toContain('data-ui-agent-overlay');
  });

  it('deduplicates repeated computed styles without changing source ids or text', () => {
    const document = installDom(`<!doctype html><html><head><title>重复样式页</title></head><body>
      <button style="display:inline-block;color:rgb(0, 0, 0)">确定</button>
      <button style="display:inline-block;color:rgb(0, 0, 0)">取消</button>
    </body></html>`);

    const snapshot = captureStaticSnapshot(document.body as unknown as HTMLElement, true);

    expect(snapshot.html.match(/\.ui-snapshot-style-\d+\{/g)).toHaveLength(1);
    expect(snapshot.html.match(/class="ui-snapshot-style-0"/g)).toHaveLength(2);
    expect(snapshot.html).toContain('确定');
    expect(snapshot.html).toContain('取消');
    expect(snapshot.metrics?.uniqueStyleRuleCount).toBe(1);
    expect(snapshot.metrics?.styleDedupSavedChars).toBeGreaterThan(0);
  });

  it('keeps automatic computed styles and removes empty paragraphs introduced by serialization', () => {
    const document = installDom(`<!doctype html><html><head><title>样式还原页</title></head><body>
      <p id="description"></p>
    </body></html>`);
    const description = document.querySelector('#description') as HTMLElement;
    const nestedBlock = document.createElement('div');
    nestedBlock.textContent = '说明内容';
    description.appendChild(nestedBlock);
    const quickStart = document.createElement('div');
    quickStart.textContent = '快捷开始';
    quickStart.style.setProperty('background-image', 'linear-gradient(rgb(229, 238, 255), rgba(229, 238, 255, 0))');
    quickStart.style.setProperty('clip-path', 'inset(0)');
    quickStart.style.setProperty('--theme-color', 'red');
    document.body.appendChild(quickStart);

    const snapshot = captureStaticSnapshot(document.body as unknown as HTMLElement, true);

    expect(snapshot.html).toContain('background-image:linear-gradient');
    expect(snapshot.html).toContain('clip-path:inset(0)');
    expect(snapshot.html).toContain('--theme-color:red');
    expect(snapshot.html).not.toContain('<p></p>');
    expect(snapshot.html).toContain('说明内容');
  });

  it('preserves fixed overlay offsets so an open modal remains visible', () => {
    const document = installDom(`<!doctype html><html><head><title>弹窗页面</title></head><body>
      <main>页面内容</main>
      <div class="modal-centered" style="position:fixed;inset:0;top:0;right:0;bottom:0;left:0;z-index:1000">
        <div role="dialog">当前打开的弹窗</div>
      </div>
    </body></html>`);

    const snapshot = captureStaticSnapshot(document.body as unknown as HTMLElement, true);

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

    const snapshot = captureStaticSnapshot(document.body as unknown as HTMLElement, true);

    expect(snapshot.html).toContain('width:100%;min-width:1280px;min-height:800px');
    expect(snapshot.html).toContain('body{padding:0');
    expect(snapshot.html).not.toContain('width:max-content');
    expect(snapshot.html).toContain('margin:0 auto;transform:translateZ(0)');
    expect(snapshot.html).toContain('font-family:PingFang SC,Microsoft YaHei,Arial,sans-serif');
    expect(snapshot.html).toMatch(/\.ui-snapshot-style-\d+\{display:block;font-size:14px;white-space:nowrap\}/);
    expect(snapshot.metrics?.optimizationVersion).toBe('style-dedup-v1');
    expect(snapshot.metrics?.uniqueStyleRuleCount).toBeGreaterThan(0);
    expect(snapshot.metrics?.serializedHtmlCharsAfter).toBe(snapshot.html.length);
  });
});
