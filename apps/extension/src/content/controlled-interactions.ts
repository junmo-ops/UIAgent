const ACTION_ATTRIBUTE = 'data-ui-agent-action';
const TARGETS_ATTRIBUTE = 'data-ui-agent-targets';
const GROUP_ATTRIBUTE = 'data-ui-agent-state-group';
const VALUE_ATTRIBUTE = 'data-ui-agent-state-value';
const WHEN_ATTRIBUTE = 'data-ui-agent-state-when';
const ACTIVE_CLASS_ATTRIBUTE = 'data-ui-agent-active-class';
const CHECKED_ATTRIBUTE = 'aria-checked';
const DISMISS_ATTRIBUTE = 'data-ui-agent-dismiss';

type ControlledAction = 'toggle' | 'show' | 'hide' | 'set-state' | 'toggle-checkbox' | 'set-radio';

function safeToken(value: string | null, maxLength = 100): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= maxLength && /^[a-zA-Z0-9_-]+$/.test(normalized)
    ? normalized
    : undefined;
}

export class ControlledInteractionRuntime {
  private readonly click = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    this.dismissOutside(event.target);
    const control = event.target.closest<HTMLElement>(`[${ACTION_ATTRIBUTE}]`);
    if (!control || !this.activate(control)) return;
    event.preventDefault();
  };

  private readonly keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      const control = [...this.openLayers].reverse().find(item => item.isConnected &&
        this.targets(item).some(panel => !panel.hidden) && this.dismissModes(item).includes('escape'));
      if (control) { this.closeLayer(control); control.focus(); event.preventDefault(); }
      return;
    }
    if (event.key !== ' ' && event.key !== 'Enter') return;
    if (!(event.target instanceof HTMLElement)) return;
    const control = event.target.closest<HTMLElement>(`[${ACTION_ATTRIBUTE}]`);
    if (!control || !this.activate(control)) return;
    event.preventDefault();
  };

  constructor(private readonly document: Document) {}
  private readonly openLayers = new Set<HTMLElement>();

  private dismissModes(control: HTMLElement): string[] {
    return (control.getAttribute(DISMISS_ATTRIBUTE) ?? '').split(/\s+/);
  }

  private closeLayer(control: HTMLElement): void {
    const targets = this.targets(control);
    for (const target of targets) this.setVisible(target, false);
    for (const trigger of this.document.querySelectorAll<HTMLElement>(`[${TARGETS_ATTRIBUTE}]`)) {
      const triggerTargets = this.targets(trigger);
      if (triggerTargets.some(target => targets.includes(target))) {
        trigger.setAttribute('aria-expanded', String(triggerTargets.some(target => !target.hidden)));
      }
    }
    this.openLayers.delete(control);
  }

  private dismissOutside(target: Element): void {
    for (const control of [...this.openLayers]) {
      if (!control.isConnected || !this.targets(control).some(panel => !panel.hidden)) {
        this.openLayers.delete(control);
        continue;
      }
      if (this.dismissModes(control).includes('outside') && !control.contains(target)
        && !this.targets(control).some(panel => panel.contains(target))) this.closeLayer(control);
    }
  }

  mount(): void {
    this.document.addEventListener('click', this.click);
    this.document.addEventListener('keydown', this.keydown);
  }

  unmount(): void {
    this.document.removeEventListener('click', this.click);
    this.document.removeEventListener('keydown', this.keydown);
    this.openLayers.clear();
  }

  activate(control: HTMLElement): boolean {
    const action = control.getAttribute(ACTION_ATTRIBUTE) as ControlledAction | null;
    if (action === 'toggle-checkbox') return this.toggleCheckbox(control);
    if (action === 'set-radio') return this.setRadio(control);
    if (action === 'set-state') return this.setState(control);
    if (action !== 'toggle' && action !== 'show' && action !== 'hide') return false;
    const targets = this.targets(control);
    if (!targets.length) return false;
    const makeVisible = action === 'show' || (action === 'toggle' && targets.some(target => target.hidden));
    for (const target of targets) this.setVisible(target, makeVisible);
    control.setAttribute('aria-expanded', String(makeVisible));
    if (makeVisible && control.hasAttribute(DISMISS_ATTRIBUTE)) {
      this.openLayers.delete(control);
      this.openLayers.add(control);
    } else this.openLayers.delete(control);
    return true;
  }

  private toggleCheckbox(control: HTMLElement): boolean {
    const checked = control.getAttribute(CHECKED_ATTRIBUTE) === 'true'
      || (control.tagName === 'INPUT' && (control as HTMLInputElement).checked);
    const next = !checked;
    if (control.tagName === 'INPUT') (control as HTMLInputElement).checked = next;
    control.setAttribute(CHECKED_ATTRIBUTE, String(next));
    control.setAttribute('data-ui-agent-state-active', String(next));
    const activeClass = safeToken(control.getAttribute(ACTIVE_CLASS_ATTRIBUTE), 120);
    if (activeClass) control.classList.toggle(activeClass, next);
    for (const target of this.targets(control)) this.setVisible(target, next);
    return true;
  }

  private setRadio(control: HTMLElement): boolean {
    const group = safeToken(control.getAttribute(GROUP_ATTRIBUTE), 80);
    const value = safeToken(control.getAttribute(VALUE_ATTRIBUTE), 80);
    if (!group || !value) return false;
    for (const element of this.document.querySelectorAll<HTMLElement>(`[${ACTION_ATTRIBUTE}="set-radio"]`)) {
      if (element.getAttribute(GROUP_ATTRIBUTE) !== group) continue;
      const active = element === control;
      element.setAttribute(CHECKED_ATTRIBUTE, String(active));
      element.setAttribute('aria-selected', String(active));
      element.setAttribute('data-ui-agent-state-active', String(active));
      const activeClass = safeToken(element.getAttribute(ACTIVE_CLASS_ATTRIBUTE), 120);
      if (activeClass) element.classList.toggle(activeClass, active);
    }
    for (const panel of this.document.querySelectorAll<HTMLElement>(`[${GROUP_ATTRIBUTE}][${WHEN_ATTRIBUTE}]`)) {
      if (panel.getAttribute(GROUP_ATTRIBUTE) !== group) continue;
      const states = (panel.getAttribute(WHEN_ATTRIBUTE) ?? '').split(/\s+/).filter(Boolean);
      this.setVisible(panel, states.includes(value));
    }
    for (const target of this.targets(control)) this.setVisible(target, true);
    return true;
  }

  private targets(control: HTMLElement): HTMLElement[] {
    const ids = (control.getAttribute(TARGETS_ATTRIBUTE) ?? '')
      .split(/\s+/)
      .map(value => safeToken(value))
      .filter((value): value is string => Boolean(value))
      .slice(0, 20);
    if (!ids.length) return [];
    const wanted = new Set(ids);
    return [...this.document.querySelectorAll<HTMLElement>('[data-ui-source-id]')]
      .filter(element => wanted.has(element.getAttribute('data-ui-source-id') ?? ''));
  }

  private setState(control: HTMLElement): boolean {
    const group = safeToken(control.getAttribute(GROUP_ATTRIBUTE), 80);
    const value = safeToken(control.getAttribute(VALUE_ATTRIBUTE), 80);
    if (!group || !value) return false;
    let matchedPanel = false;
    for (const element of this.document.querySelectorAll<HTMLElement>(`[${GROUP_ATTRIBUTE}]`)) {
      if (element.getAttribute(GROUP_ATTRIBUTE) !== group) continue;
      const when = (element.getAttribute(WHEN_ATTRIBUTE) ?? '').split(/\s+/).filter(Boolean);
      if (when.length) {
        const active = when.includes(value);
        this.setVisible(element, active);
        matchedPanel ||= active;
        continue;
      }
      if (element.getAttribute(ACTION_ATTRIBUTE) !== 'set-state') continue;
      const active = element.getAttribute(VALUE_ATTRIBUTE) === value;
      element.setAttribute('aria-selected', String(active));
      element.setAttribute('aria-pressed', String(active));
      element.setAttribute('data-ui-agent-state-active', String(active));
      const activeClass = safeToken(element.getAttribute(ACTIVE_CLASS_ATTRIBUTE), 120);
      if (activeClass) element.classList.toggle(activeClass, active);
    }
    return matchedPanel;
  }

  private setVisible(element: HTMLElement, visible: boolean): void {
    element.hidden = !visible;
    element.setAttribute('aria-hidden', String(!visible));
  }
}
