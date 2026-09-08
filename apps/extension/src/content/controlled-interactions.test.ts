import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { ControlledInteractionRuntime } from './controlled-interactions';

function setup(html: string) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  return { document, runtime: new ControlledInteractionRuntime(document) };
}

describe('ControlledInteractionRuntime', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['display:block', 'display:flex', 'display:grid', 'position:relative', 'overflow:auto;height:80px'])(
    'dismisses outside or Escape but preserves inside clicks in %s containers', style => {
      const { document, runtime } = setup(`<main style="${style}">
        <button id="trigger" data-ui-agent-action="toggle" data-ui-agent-targets="panel" data-ui-agent-dismiss="outside escape">open</button>
        <section data-ui-source-id="panel" hidden><input id="field"></section>
        <button id="outside">outside</button></main>`);
      vi.stubGlobal('Element', document.defaultView!.Element);
      vi.stubGlobal('HTMLElement', document.defaultView!.HTMLElement);
      const trigger = document.querySelector<HTMLElement>('#trigger')!;
      const panel = document.querySelector<HTMLElement>('[data-ui-source-id="panel"]')!;
      const click = (selector: string) => document.querySelector(selector)!.dispatchEvent(new document.defaultView!.Event('click', { bubbles: true, cancelable: true }));
      const focus = vi.spyOn(trigger, 'focus');
      runtime.mount();
      click('#trigger'); expect(panel.hidden).toBe(false);
      click('#field'); expect(panel.hidden).toBe(false);
      expect(click('#outside')).toBe(true);
      expect(panel.hidden).toBe(true);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      click('#trigger'); click('#trigger'); expect(panel.hidden).toBe(true);
      click('#trigger');
      const escape = new document.defaultView!.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(escape, 'key', { value: 'Escape' });
      document.querySelector('#field')!.dispatchEvent(escape);
      expect(panel.hidden).toBe(true); expect(focus).toHaveBeenCalled();
      runtime.unmount(); click('#trigger'); expect(panel.hidden).toBe(true);
    });
  it('toggles, shows, and hides stable source-id targets', () => {
    const { document, runtime } = setup(`
      <button id="toggle" data-ui-agent-action="toggle" data-ui-agent-targets="source-2"></button>
      <button id="hide" data-ui-agent-action="hide" data-ui-agent-targets="source-2"></button>
      <section data-ui-source-id="source-2" hidden></section>
    `);
    const panel = document.querySelector<HTMLElement>('[data-ui-source-id="source-2"]')!;

    expect(runtime.activate(document.querySelector<HTMLElement>('#toggle')!)).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(runtime.activate(document.querySelector<HTMLElement>('#hide')!)).toBe(true);
    expect(panel.hidden).toBe(true);
  });

  it('switches a declarative state group and active control class', () => {
    const { document, runtime } = setup(`
      <button id="a" class="tab active" data-ui-agent-action="set-state" data-ui-agent-state-group="tabs" data-ui-agent-state-value="a" data-ui-agent-active-class="active"></button>
      <button id="b" class="tab" data-ui-agent-action="set-state" data-ui-agent-state-group="tabs" data-ui-agent-state-value="b" data-ui-agent-active-class="active"></button>
      <section id="panel-a" data-ui-agent-state-group="tabs" data-ui-agent-state-when="a"></section>
      <section id="panel-b" data-ui-agent-state-group="tabs" data-ui-agent-state-when="b" hidden></section>
    `);

    expect(runtime.activate(document.querySelector<HTMLElement>('#b')!)).toBe(true);
    expect(document.querySelector<HTMLElement>('#panel-a')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#panel-b')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#a')!.classList.contains('active')).toBe(false);
    expect(document.querySelector<HTMLElement>('#b')!.classList.contains('active')).toBe(true);
    expect(document.querySelector('#b')!.getAttribute('aria-selected')).toBe('true');
  });

  it('toggles checkbox state, active class, and optional targets', () => {
    const { document, runtime } = setup(`
      <span id="check" class="box" role="checkbox" aria-checked="false" tabindex="0"
        data-ui-agent-action="toggle-checkbox" data-ui-agent-active-class="active"
        data-ui-agent-targets="source-2"></span>
      <section data-ui-source-id="source-2" hidden></section>
    `);
    const check = document.querySelector<HTMLElement>('#check')!;
    expect(runtime.activate(check)).toBe(true);
    expect(check.getAttribute('aria-checked')).toBe('true');
    expect(check.classList.contains('active')).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-ui-source-id="source-2"]')!.hidden).toBe(false);
    expect(runtime.activate(check)).toBe(true);
    expect(check.getAttribute('aria-checked')).toBe('false');
  });

  it('selects one radio in a group', () => {
    const { document, runtime } = setup(`
      <button id="a" aria-checked="true" data-ui-agent-action="set-radio" data-ui-agent-state-group="status" data-ui-agent-state-value="a" data-ui-agent-active-class="active" class="active"></button>
      <button id="b" aria-checked="false" data-ui-agent-action="set-radio" data-ui-agent-state-group="status" data-ui-agent-state-value="b" data-ui-agent-active-class="active"></button>
      <section id="panel-a" data-ui-agent-state-group="status" data-ui-agent-state-when="a"></section>
      <section id="panel-b" data-ui-agent-state-group="status" data-ui-agent-state-when="b" hidden></section>
    `);
    expect(runtime.activate(document.querySelector<HTMLElement>('#b')!)).toBe(true);
    expect(document.querySelector('#a')!.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('#b')!.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('#a')!.classList.contains('active')).toBe(false);
    expect(document.querySelector('#b')!.classList.contains('active')).toBe(true);
    expect(document.querySelector<HTMLElement>('#panel-a')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#panel-b')!.hidden).toBe(false);
  });

  it('ignores unsupported actions and unsafe target tokens', () => {
    const { document, runtime } = setup('<button id="bad" data-ui-agent-action="script" data-ui-agent-targets="source-1,body"></button>');
    expect(runtime.activate(document.querySelector<HTMLElement>('#bad')!)).toBe(false);
  });
});
