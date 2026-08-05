import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { ControlledInteractionRuntime } from './controlled-interactions';

function setup(html: string) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  return { document, runtime: new ControlledInteractionRuntime(document) };
}

describe('ControlledInteractionRuntime', () => {
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

  it('ignores unsupported actions and unsafe target tokens', () => {
    const { document, runtime } = setup('<button id="bad" data-ui-agent-action="script" data-ui-agent-targets="source-1,body"></button>');
    expect(runtime.activate(document.querySelector<HTMLElement>('#bad')!)).toBe(false);
  });
});
