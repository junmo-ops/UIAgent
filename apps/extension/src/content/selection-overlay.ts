import type { ElementRef, PageSelection } from '@ui-agent/contracts';

export class SelectionOverlay {
  private selected: HTMLElement | null = null;
  private readonly overlay: HTMLDivElement;
  private enabled = false;

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

  disable(): void {
    this.enabled = false;
    this.overlay.style.display = 'none';
  }

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
