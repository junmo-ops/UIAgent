const interactiveSelector = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="switch"]',
  '[role="tab"]'
].join(',');

/**
 * Component libraries often render labels and icons inside an interactive root.
 * Selecting that child would make the actual control read-only under our exact
 * selection policy, so normalize only well-known interactive ancestors.
 */
export function selectionTarget(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  // Generated React descendants are not persisted HTML source nodes.
  const moduleHost = target.closest('ui-agent-module');
  if (moduleHost instanceof HTMLElement) return moduleHost;
  const interactive = target.closest(interactiveSelector);
  if (interactive instanceof HTMLElement) return interactive;
  if (target instanceof HTMLElement) return target;
  return target.parentElement ?? undefined;
}
