import { describe, expect, it } from 'vitest';
import { validateControlledInteractions } from './interactions';

describe('validateControlledInteractions', () => {
  it('validates dismiss modes and referenced targets', () => {
    const html = '<button data-ui-agent-action="toggle" data-ui-agent-targets="panel" data-ui-agent-dismiss="outside escape"></button><div data-ui-source-id="panel" hidden></div>';
    expect(() => validateControlledInteractions(`<html><body>${html}</body></html>`)).not.toThrow();
    expect(() => validateControlledInteractions(html.replace('outside escape', 'arbitrary'))).toThrow('data-ui-agent-dismiss');
    expect(() => validateControlledInteractions(html.replace('action="toggle"', 'action="hide"'))).toThrow('data-ui-agent-dismiss');
  });
  it('accepts safe visibility and state declarations', () => {
    expect(() => validateControlledInteractions(`<!doctype html><html><body>
      <button data-ui-source-id="source-1" data-ui-agent-action="toggle" data-ui-agent-targets="source-2"></button>
      <section data-ui-source-id="source-2" hidden></section>
      <button data-ui-source-id="source-3" data-ui-agent-action="set-state" data-ui-agent-state-group="tabs" data-ui-agent-state-value="a"></button>
      <section data-ui-source-id="source-4" data-ui-agent-state-group="tabs" data-ui-agent-state-when="a"></section>
    </body></html>`)).not.toThrow();
  });

  it('rejects unknown actions, missing targets, and incomplete state groups', () => {
    expect(() => validateControlledInteractions('<html><body><button data-ui-agent-action="run-script"></button></body></html>'))
      .toThrow('不支持的受控交互动作');
    expect(() => validateControlledInteractions('<html><body><button data-ui-agent-action="show" data-ui-agent-targets="source-99"></button></body></html>'))
      .toThrow('目标 source-99 不存在');
    expect(() => validateControlledInteractions('<html><body><button data-ui-agent-action="set-state" data-ui-agent-state-group="tabs" data-ui-agent-state-value="a"></button></body></html>'))
      .toThrow('没有对应的展示面板');
  });

  it('accepts declarative checkbox and radio actions', () => {
    expect(() => validateControlledInteractions(`
      <span data-ui-agent-action="toggle-checkbox" aria-checked="false"></span>
      <button data-ui-agent-action="set-radio" data-ui-agent-state-group="status" data-ui-agent-state-value="approved"></button>
    `)).not.toThrow();
  });

  it('rejects invalid checkbox state metadata', () => {
    expect(() => validateControlledInteractions(
      '<span data-ui-agent-action="toggle-checkbox" data-ui-agent-state-group="status"></span>'
    )).toThrow();
    expect(() => validateControlledInteractions(
      '<span data-ui-agent-action="toggle-checkbox" data-ui-agent-targets="missing"></span>'
    )).toThrow();
  });
});
