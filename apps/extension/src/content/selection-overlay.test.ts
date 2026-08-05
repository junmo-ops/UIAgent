import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { SelectionOverlay } from './selection-overlay';

function installDom() {
  const { window } = parseHTML('<!doctype html><html><body><button data-ui-source-id="source-7">查询</button></body></html>');
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  const button = window.document.querySelector('button') as unknown as HTMLElement;
  button.getBoundingClientRect = () => ({
    x: 20, y: 30, left: 20, top: 30, right: 100, bottom: 62, width: 80, height: 32,
    toJSON: () => ({})
  });
  return { document: window.document, button };
}

describe('SelectionOverlay', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns only the lightweight page selection and hides when disabled', () => {
    const { document, button } = installDom();
    const overlay = new SelectionOverlay();

    expect(overlay.select(button)).toEqual({
      selected: expect.objectContaining({
        id: 'source-7', sourceId: 'source-7', tag: 'button', text: '查询',
        rect: { x: 20, y: 30, width: 80, height: 32 }
      })
    });
    const marker = document.querySelector('[data-ui-agent-overlay]') as HTMLElement;
    expect(marker.style.display).toBe('block');

    overlay.disable();
    expect(marker.style.display).toBe('none');
  });
});
