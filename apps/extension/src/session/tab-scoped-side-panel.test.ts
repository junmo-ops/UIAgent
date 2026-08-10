import { describe, expect, it, vi } from 'vitest';
import {
  disableGlobalSidePanel,
  openTabScopedSidePanel,
  SIDE_PANEL_PATH,
  type TabScopedSidePanelApi
} from './tab-scoped-side-panel';

function sidePanelApi() {
  const calls: Array<{ method: 'setOptions' | 'open'; options: unknown }> = [];
  const api: TabScopedSidePanelApi = {
    setOptions: vi.fn(async options => { calls.push({ method: 'setOptions', options }); }),
    open: vi.fn(async options => { calls.push({ method: 'open', options }); })
  };
  return { api, calls };
}

describe('tab-scoped side panel', () => {
  it('disables the manifest-level global fallback', async () => {
    const { api, calls } = sidePanelApi();
    await disableGlobalSidePanel(api);
    expect(calls).toEqual([{
      method: 'setOptions',
      options: { path: SIDE_PANEL_PATH, enabled: false }
    }]);
  });

  it('creates a tab-specific panel before opening it', async () => {
    const { api, calls } = sidePanelApi();
    await openTabScopedSidePanel(api, 42);
    expect(calls).toEqual([
      {
        method: 'setOptions',
        options: { tabId: 42, path: SIDE_PANEL_PATH, enabled: true }
      },
      { method: 'open', options: { tabId: 42 } }
    ]);
  });

  it('calls open synchronously without waiting for configuration', async () => {
    let finishConfiguration!: () => void;
    const configuration = new Promise<void>(resolve => { finishConfiguration = resolve; });
    const open = vi.fn(async () => undefined);
    const api: TabScopedSidePanelApi = {
      setOptions: vi.fn(() => configuration),
      open
    };
    const result = openTabScopedSidePanel(api, 42);
    expect(open).toHaveBeenCalledWith({ tabId: 42 });
    finishConfiguration();
    await expect(result).resolves.toBeUndefined();
  });
});
