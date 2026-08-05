import { describe, expect, it } from 'vitest';
import { EditorTabRegistry } from './editor-tab-registry';

describe('EditorTabRegistry', () => {
  it('keeps each side panel bound to the tab on which it was opened', () => {
    const registry = new EditorTabRegistry();
    registry.bind('editor-a', 11);
    registry.bind('editor-b', 22);
    expect(registry.resolve('editor-a')).toBe(11);
    expect(registry.resolve('editor-b')).toBe(22);
  });

  it('only marks the last editor disconnect as a reason to deactivate a tab', () => {
    const registry = new EditorTabRegistry();
    registry.bind('editor-a', 11);
    registry.bind('editor-b', 11);
    expect(registry.unbind('editor-a')).toEqual({ tabId: 11, lastEditorForTab: false });
    expect(registry.unbind('editor-b')).toEqual({ tabId: 11, lastEditorForTab: true });
  });

  it('clears all bindings when a tab closes', () => {
    const registry = new EditorTabRegistry();
    registry.bind('editor-a', 11);
    registry.bind('editor-b', 11);
    expect(registry.removeTab(11).sort()).toEqual(['editor-a', 'editor-b']);
    expect(registry.resolve('editor-a')).toBeUndefined();
  });

  it('waits for an asynchronous side-panel binding', async () => {
    const registry = new EditorTabRegistry();
    setTimeout(() => registry.bind('editor-a', 11), 10);
    await expect(registry.waitFor('editor-a', 100)).resolves.toBe(11);
  });
});
