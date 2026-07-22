export interface ReleasedEditorTab {
  tabId: number;
  lastEditorForTab: boolean;
}

export class EditorTabRegistry {
  private readonly editorTabs = new Map<string, number>();
  private readonly tabEditors = new Map<number, Set<string>>();

  bind(editorClientId: string, tabId: number): void {
    this.unbind(editorClientId);
    this.editorTabs.set(editorClientId, tabId);
    const editors = this.tabEditors.get(tabId) ?? new Set<string>();
    editors.add(editorClientId);
    this.tabEditors.set(tabId, editors);
  }

  resolve(editorClientId: string): number | undefined {
    return this.editorTabs.get(editorClientId);
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
