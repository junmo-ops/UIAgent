import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { selectionTarget } from './selection-target';

function installDom(html: string) {
  const { window } = parseHTML(html);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  return window.document;
}

describe('selectionTarget', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('promotes a component-library label span to its button root', () => {
    const document = installDom('<button data-testid="submit"><span><span>提交订单</span></span></button>');
    const label = document.querySelector('span span')!;
    expect(selectionTarget(label)?.getAttribute('data-testid')).toBe('submit');
  });

  it('promotes nested link and ARIA control content to the interactive root', () => {
    const document = installDom('<a href="/detail"><strong>详情</strong></a><div role="switch"><i>启用</i></div>');
    expect(selectionTarget(document.querySelector('strong'))?.tagName).toBe('A');
    expect(selectionTarget(document.querySelector('i'))?.getAttribute('role')).toBe('switch');
  });

  it('keeps ordinary layout content as the exact selected element', () => {
    const document = installDom('<section><span data-testid="copy">说明文字</span></section>');
    expect(selectionTarget(document.querySelector('span'))?.getAttribute('data-testid')).toBe('copy');
  });

  it('promotes declarative interaction content to its trigger element', () => {
    const document = installDom('<div data-ui-agent-action="toggle" data-ui-agent-targets="source-2"><span>展开</span></div>');
    expect(selectionTarget(document.querySelector('span'))?.getAttribute('data-ui-agent-action')).toBe('toggle');
  });
});
