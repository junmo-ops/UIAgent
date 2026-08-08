export interface ReleasedEditorTab {
  tabId: number;
  lastEditorForTab: boolean;
}

export class EditorTabRegistry {
  private readonly editorTabs = new Map<string, number>();
  private readonly tabEditors = new Map<number, Set<string>>();

  bind(editorClientId: string, tabId: number): boolean {
    const existingTabId = this.editorTabs.get(editorClientId);
    if (existingTabId !== undefined) return existingTabId === tabId;
    this.editorTabs.set(editorClientId, tabId);
    const editors = this.tabEditors.get(tabId) ?? new Set<string>();
    editors.add(editorClientId);
    this.tabEditors.set(tabId, editors);
    return true;
  }

  resolve(editorClientId: string): number | undefined {
    return this.editorTabs.get(editorClientId);
  }

  async waitFor(editorClientId: string, timeoutMs = 1500): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    let tabId = this.resolve(editorClientId);
    while (tabId === undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      tabId = this.resolve(editorClientId);
    }
    return tabId;
  }

  unbind(editorClientId: string): ReleasedEditorTab | undefined {
    const tabId = this.editorTabs.get(editorClientId);
    if (tabId === undefined) return undefined;
    this.editorTabs.delete(editorClientId);
    const editors = this.tabEditors.get(tabId);
    editors?.delete(editorClientId);
    const lastEditorForTab = !editors?.size;
    if (lastEditorForTab) this.tabEditors.delete(tabId);
    return { tabId, lastEditorForTab };
  }

  removeTab(tabId: number): string[] {
    const editors = [...(this.tabEditors.get(tabId) ?? [])];
    editors.forEach(editorClientId => this.editorTabs.delete(editorClientId));
    this.tabEditors.delete(tabId);
    return editors;
  }
}
