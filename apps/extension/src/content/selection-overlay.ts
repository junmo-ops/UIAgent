import type { ElementRef, PageSelection } from '@ui-agent/contracts';

export class SelectionOverlay {
  private selected: HTMLElement | null = null;
  private readonly overlay: HTMLDivElement;
  private enabled = false;
  private explicitlyCleared = false;

  constructor() {
    document.querySelectorAll('[data-ui-agent-overlay]').forEach(node => node.remove());
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, {
      position: 'fixed',
      pointerEvents: 'none',
      border: '2px solid #1677ff',
      background: 'rgba(22,119,255,.08)',
      zIndex: '2147483647',
      display: 'none',
      boxSizing: 'border-box',
      transition: 'all 60ms linear'
    });
    this.overlay.setAttribute('data-ui-agent-overlay', 'true');
    document.documentElement.appendChild(this.overlay);
  }

  select(element: HTMLElement): PageSelection {
    this.explicitlyCleared = false;
    this.enabled = true;
    this.selected = element;
    this.show(element);
    return { selected: this.reference(element) };
  }

  preview(element: HTMLElement): void {
    this.enabled = true;
    this.show(element);
  }

  enable(): void {
    this.enabled = true;
  }

  restore(sourceId?: string, visible = true): PageSelection | undefined {
    // An in-flight heartbeat may still carry the target from before Escape.
    if (this.explicitlyCleared) return undefined;
    const id = sourceId ?? this.selected?.getAttribute('data-ui-source-id');
    if (id) this.selected = document.querySelector<HTMLElement>(`[data-ui-source-id="${CSS.escape(id)}"]`);
    if (!this.selected?.isConnected) {
      this.selected = null;
      if (visible) this.hide();
      return undefined;
    }
    if (visible) {
      this.enable();
      this.refresh();
    }
    return { selected: this.reference(this.selected) };
  }

  disable(): void {
    this.enabled = false;
    this.overlay.style.display = 'none';
  }

  clear(): void {
    // Release only focus inside the cancelled target. Do not remove the site's
    // focus styles or blur unrelated controls (including the chat composer).
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    let ancestor: Node | null = focused;
    while (ancestor && ancestor !== this.selected) {
      ancestor = ancestor.parentNode ?? (ancestor instanceof ShadowRoot ? ancestor.host : null);
    }
    if (this.selected && ancestor === this.selected && focused instanceof HTMLElement) focused.blur();
    this.selected = null;
    this.explicitlyCleared = true;
    this.disable();
  }

  get hasSelection(): boolean { return this.enabled && Boolean(this.selected); }

  hide(): void {
    this.overlay.style.display = 'none';
  }

  refresh(): void {
    if (!this.enabled || !this.selected?.isConnected) {
      this.overlay.style.display = 'none';
      return;
    }
    this.show(this.selected);
  }

  private show(element: HTMLElement): void {
    if (!this.enabled) return;
    const rect = element.getBoundingClientRect();
    Object.assign(this.overlay.style, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
  }

  private reference(element: HTMLElement): ElementRef {
    const sourceId = element.getAttribute('data-ui-source-id') ?? undefined;
    const rect = element.getBoundingClientRect();
    return {
      id: sourceId ?? (element.id || `selected-${crypto.randomUUID()}`),
      sourceId,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') ?? undefined,
      text: (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  }
}
