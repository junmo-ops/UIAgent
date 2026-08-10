export const SIDE_PANEL_PATH = 'sidepanel.html';

export interface TabScopedSidePanelApi {
  setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
  open(options: { tabId: number }): Promise<void>;
}

export async function disableGlobalSidePanel(api: TabScopedSidePanelApi): Promise<void> {
  await api.setOptions({ path: SIDE_PANEL_PATH, enabled: false });
}

export async function openTabScopedSidePanel(
  api: TabScopedSidePanelApi,
  tabId: number
): Promise<void> {
  // Both calls must be issued in the original action-click stack. Awaiting
  // setOptions first consumes Chrome's transient user activation and causes
  // sidePanel.open() to be rejected even though the click was user initiated.
  const configuration = api.setOptions({ tabId, path: SIDE_PANEL_PATH, enabled: true });
  const opening = api.open({ tabId });
  await Promise.all([configuration, opening]);
}
