import {
  PROTOCOL_VERSION,
  type ChangePlan,
  type DomTreeNode,
  type ElementRef,
  type ExecutionReceipt,
  type NodeTarget,
  type SelectedContext,
  type UIChangeOperation
} from '@ui-agent/contracts';
import { validatePlan } from '@ui-agent/domain';

interface Action { apply(): void; revert(): void }
interface Transaction { planId: string; actions: Action[] }

const ownAttribute = 'data-ui-agent-id';
const styleProperties = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'display', 'flexDirection', 'gap', 'padding', 'margin', 'border', 'borderRadius', 'width', 'height'] as const;
const safeContextAttributes = new Set(['aria-label', 'aria-selected', 'aria-expanded', 'role', 'type', 'placeholder', 'title', 'href', 'data-ui-component']);
const forbiddenCloneTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED']);

export class DomEngine {
  private selected: HTMLElement | null = null;
  private selectionVersion = 0;
  private pageRevision = 0;
  private readonly elements = new Map<string, HTMLElement>();
  private readonly addedIds = new Set<string>();
  private readonly undoStack: Transaction[] = [];
  private readonly redoStack: Transaction[] = [];
  private overlay: HTMLDivElement;
  private overlayEnabled = false;

  constructor() {
    // 插件重新加载会销毁旧 Content Script，但其 DOM 浮层可能仍留在页面中。
    document.querySelectorAll('[data-ui-agent-overlay]').forEach(node => node.remove());
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, {
      position: 'fixed', pointerEvents: 'none', border: '2px solid #1677ff', background: 'rgba(22,119,255,.08)',
      zIndex: '2147483647', display: 'none', boxSizing: 'border-box', transition: 'all 60ms linear'
    });
    this.overlay.setAttribute('data-ui-agent-overlay', 'true');
    document.documentElement.appendChild(this.overlay);
  }

  select(element: HTMLElement): SelectedContext {
    this.overlayEnabled = true;
    this.selected = element;
    this.selectionVersion += 1;
    this.showOverlay(element);
    return this.context();
  }

  preview(element: HTMLElement): void {
    this.overlayEnabled = true;
    this.showOverlay(element);
  }

  context(): SelectedContext {
    if (!this.selected) throw new Error('请先选择页面元素');
    const selected = this.reference(this.selected);
    const parent = this.selected.parentElement;
    if (!parent) throw new Error('选中元素没有可编辑父容器');
    const parentStyle = getComputedStyle(parent);
    const selectedStyle = getComputedStyle(this.selected);
    const visibleStyle = Object.fromEntries(styleProperties.map(name => [name, selectedStyle[name]]));
    const treeBudget = { remaining: 80 };
    const localScopeRoot = this.localScopeRoot(this.selected);
    const reusableTrees = this.findReusableRoots(localScopeRoot)
      .slice(0, 3)
      .map(element => this.describeTree(element, 0, treeBudget));
    const selectedTree = this.describeTree(localScopeRoot, 0, treeBudget);
    const siblings = [...parent.children]
      .filter(node => node !== this.selected && node instanceof HTMLElement && !node.hasAttribute('data-ui-agent-overlay'))
      .slice(0, 8)
      .map(node => this.describe(node as HTMLElement));
    return {
      protocolVersion: PROTOCOL_VERSION,
      selectionVersion: this.selectionVersion,
      pageRevision: this.pageRevision,
      page: { title: document.title, url: location.href, viewportWidth: innerWidth, viewportHeight: innerHeight },
      selected,
      selectedTree,
      reusableTrees,
      parent: { tag: parent.tagName.toLowerCase(), display: parentStyle.display, flexDirection: parentStyle.flexDirection, gap: parentStyle.gap },
      siblings,
      visibleStyle,
      addedElements: [...this.addedIds]
        .map(id => this.elements.get(id))
        .filter((element): element is HTMLElement => Boolean(element?.isConnected))
        .map(element => this.describe(element, element.getAttribute(ownAttribute) ?? undefined)),
      addedTrees: [...this.addedIds]
        .map(id => this.elements.get(id))
        .filter((element): element is HTMLElement => Boolean(element?.isConnected) && element !== this.selected && treeBudget.remaining > 0)
        .map(element => this.describeTree(element, 0, treeBudget))
    };
  }

  applyPlan(plan: ChangePlan, confirmedExistingRemoval: boolean): ExecutionReceipt {
    const context = this.context();
    validatePlan(plan, context);
    if (plan.requiresConfirmation && !confirmedExistingRemoval) throw new Error('删除已有元素前必须由用户确认');
    const applied: Action[] = [];
    const resultRefs = new Map<string, HTMLElement>();
    try {
      for (const operation of plan.operations) {
        const action = this.actionFor(operation, resultRefs);
        action.apply();
        applied.push(action);
      }
    } catch (error) {
      for (const action of applied.reverse()) action.revert();
      throw error;
    }
    const transaction = { planId: plan.planId, actions: applied };
    this.undoStack.push(transaction);
    this.redoStack.length = 0;
    this.pageRevision += 1;
    this.refreshOverlay();
    return {
      protocolVersion: PROTOCOL_VERSION, planId: plan.planId, success: true, pageRevision: this.pageRevision,
      appliedOperationIds: plan.operations.map(operation => operation.operationId)
    };
  }

  undo(): boolean {
    const transaction = this.undoStack.pop();
    if (!transaction) return false;
    for (const action of [...transaction.actions].reverse()) action.revert();
    this.redoStack.push(transaction);
    this.pageRevision += 1;
    this.refreshOverlay();
    return true;
  }

  redo(): boolean {
    const transaction = this.redoStack.pop();
    if (!transaction) return false;
    for (const action of transaction.actions) action.apply();
    this.undoStack.push(transaction);
    this.pageRevision += 1;
    this.refreshOverlay();
    return true;
  }

  reset(): void {
    while (this.undoStack.length) this.undo();
    this.redoStack.length = 0;
  }

  historyState() { return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 }; }
  enableOverlay() { this.overlayEnabled = true; this.hideOverlay(); }
  disableOverlay() { this.overlayEnabled = false; this.hideOverlay(); }
  hideOverlay() { this.overlay.style.display = 'none'; }
  refreshOverlay() {
    if (this.overlayEnabled && this.selected?.isConnected) this.showOverlay(this.selected);
    else this.hideOverlay();
  }

  private reference(element: HTMLElement): ElementRef {
    const id = this.ensureId(element);
    return this.describe(element, id);
  }

  private ensureId(element: HTMLElement): string {
    let id = element.getAttribute(ownAttribute);
    if (!id) {
      id = `el-${crypto.randomUUID()}`;
      element.setAttribute(ownAttribute, id);
    }
    this.elements.set(id, element);
    return id;
  }

  private localScopeRoot(element: HTMLElement): HTMLElement {
    return element.closest<HTMLElement>('tr,[role="row"],li') ?? element;
  }

  private findReusableRoots(scope: HTMLElement): HTMLElement[] {
    if (scope.matches('tr,[role="row"],li')) return [];
    const rows = [...scope.querySelectorAll<HTMLElement>('tr,[role="row"]')];
    if (rows.length > 0) return [rows.at(-1)!];
    const listItems = [...scope.querySelectorAll<HTMLElement>('li')];
    return listItems.length > 1 ? [listItems.at(-1)!] : [];
  }

  private describeTree(element: HTMLElement, depth: number, budget: { remaining: number }): DomTreeNode {
    budget.remaining = Math.max(0, budget.remaining - 1);
    const attributes = Object.fromEntries(
      [...element.attributes]
        .filter(attribute => safeContextAttributes.has(attribute.name))
        .map(attribute => [attribute.name, attribute.value.slice(0, 300)])
    );
    const directText = [...element.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const children: DomTreeNode[] = [];
    if (depth < 5) {
      for (const child of [...element.children]) {
        if (budget.remaining <= 0) break;
        if (child instanceof HTMLElement && !child.hasAttribute('data-ui-agent-overlay')) {
          children.push(this.describeTree(child, depth + 1, budget));
        }
      }
    }
    return {
      id: this.ensureId(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') ?? undefined,
      text: (directText || (children.length === 0 ? element.innerText : '')).trim().slice(0, 300),
      attributes,
      children
    };
  }

  private describe(element: HTMLElement, knownId?: string): ElementRef {
    const rect = element.getBoundingClientRect();
    return {
      id: knownId ?? element.getAttribute(ownAttribute) ?? `read-${crypto.randomUUID()}`,
      tag: element.tagName.toLowerCase(), role: element.getAttribute('role') ?? undefined,
      text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim().slice(0, 300),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  }

  private find(id: string): HTMLElement {
    const element = this.elements.get(id);
    if (!element) throw new Error(`页面元素 ${id} 已失效`);
    return element;
  }

  private actionFor(operation: UIChangeOperation, resultRefs: Map<string, HTMLElement>): Action {
    switch (operation.type) {
      case 'cloneSubtree': return this.cloneAction(operation, resultRefs);
      case 'addComponent': return this.addAction(operation, resultRefs);
      case 'updateContent': return this.contentAction(this.resolve(operation.target, resultRefs), operation.text);
      case 'updateStyle': return this.styleAction(this.resolve(operation.target, resultRefs), operation.styles);
      case 'removeElement': return this.removeAction(this.resolve(operation.target, resultRefs));
      case 'moveElement': return this.moveAction(this.resolve(operation.target, resultRefs), this.resolve(operation.anchor, resultRefs), operation.position);
      case 'setVisualState': return this.visualStateAction(operation, this.resolve(operation.target, resultRefs));
    }
  }

  private resolve(target: NodeTarget, resultRefs: Map<string, HTMLElement>): HTMLElement {
    if (target.kind === 'node') return this.find(target.nodeId);
    let element = resultRefs.get(target.resultRef);
    if (!element) throw new Error(`计划内引用 ${target.resultRef} 尚未产生`);
    for (const index of target.path) {
      const child: Element | null = element.children.item(index);
      if (!(child instanceof HTMLElement)) throw new Error(`计划内引用 ${target.resultRef} 的子节点路径无效`);
      element = child;
    }
    return element;
  }

  private cloneAction(operation: Extract<UIChangeOperation, { type: 'cloneSubtree' }>, resultRefs: Map<string, HTMLElement>): Action {
    const source = this.resolve(operation.source, resultRefs);
    const requestedAnchor = this.resolve(operation.anchor, resultRefs);
    const placement = this.normalizeClonePlacement(source, requestedAnchor, operation.position);
    const clone = source.cloneNode(true) as HTMLElement;
    this.sanitizeClonedTree(clone);
    const cloneId = this.ensureId(clone);
    clone.setAttribute('data-ui-agent-added', 'true');
    return {
      apply: () => {
        this.insertAt(clone, placement.anchor, placement.position);
        resultRefs.set(operation.resultRef, clone);
        this.addedIds.add(cloneId);
      },
      revert: () => {
        clone.remove();
        resultRefs.delete(operation.resultRef);
        this.addedIds.delete(cloneId);
      }
    };
  }

  private normalizeClonePlacement(
    source: HTMLElement,
    anchor: HTMLElement,
    position: 'before' | 'after' | 'insideStart' | 'insideEnd'
  ): { anchor: HTMLElement; position: 'before' | 'after' | 'insideStart' | 'insideEnd' } {
    const allowedParents: Partial<Record<string, Set<string>>> = {
      TR: new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT']),
      TD: new Set(['TR']),
      TH: new Set(['TR']),
      LI: new Set(['UL', 'OL', 'MENU']),
      OPTION: new Set(['SELECT', 'DATALIST', 'OPTGROUP'])
    };
    const parents = allowedParents[source.tagName];
    if (!parents) return { anchor, position };

    const inside = position === 'insideStart' || position === 'insideEnd';
    const structurallyValid = inside
      ? parents.has(anchor.tagName)
      : anchor.parentElement != null && parents.has(anchor.parentElement.tagName);
    if (structurallyValid) return { anchor, position };

    const sourceParent = source.parentElement;
    if (!sourceParent || !parents.has(sourceParent.tagName)) {
      throw new Error(`无法为 ${source.tagName.toLowerCase()} 找到合法的克隆插入位置`);
    }
    return { anchor: source, position: 'after' };
  }

  private sanitizeClonedTree(root: HTMLElement): void {
    root.querySelectorAll([...forbiddenCloneTags].join(',')).forEach(node => node.remove());
    for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name === 'id' || name.startsWith('data-ui-agent-') || name.startsWith('on') || name === 'srcdoc' || name === 'action' || name === 'formaction') {
          element.removeAttribute(attribute.name);
        }
        if ((name === 'href' || name === 'src') && /^(?:javascript|data):/i.test(attribute.value.trim())) element.removeAttribute(attribute.name);
        if (name === 'style' && /url\s*\(|expression\s*\(/i.test(attribute.value)) element.removeAttribute(attribute.name);
      }
      this.ensureId(element);
    }
  }

  private addAction(operation: Extract<UIChangeOperation, { type: 'addComponent' }>, resultRefs: Map<string, HTMLElement>): Action {
    const target = this.resolve(operation.anchor, resultRefs);
    const template = this.findComponentTemplate(target, operation.component);
    const node = template
      ? this.cloneComponentTemplate(template, operation.component, operation.props)
      : this.createComponent(operation.component, operation.props);
    if (!template) this.reuseNearbyStyle(node, target, operation.component);
    const insertion = template && target.contains(template)
      ? { target: template, position: 'after' as const }
      : { target, position: operation.position };
    const staticInteraction = template && operation.component === 'select'
      ? this.createStaticSelectInteraction(node, operation.props.options ?? [])
      : undefined;
    const newId = `added-${crypto.randomUUID()}`;
    node.setAttribute(ownAttribute, newId);
    node.setAttribute('data-ui-agent-added', 'true');
    const insert = () => {
      this.insertAt(node, insertion.target, insertion.position);
      this.elements.set(newId, node);
      this.addedIds.add(newId);
      if (operation.resultRef) resultRefs.set(operation.resultRef, node);
      staticInteraction?.mount();
    };
    return {
      apply: insert,
      revert: () => {
        staticInteraction?.unmount();
        node.remove();
        this.addedIds.delete(newId);
        if (operation.resultRef) resultRefs.delete(operation.resultRef);
      }
    };
  }

  private createStaticSelectInteraction(root: HTMLElement, options: string[]) {
    const control = root.matches('.ant-select') ? root : root.querySelector<HTMLElement>('.ant-select');
    const display = root.querySelector<HTMLElement>('.ant-select-selection-placeholder, .ant-select-selection-item');
    let panel: HTMLDivElement | undefined;

    const close = () => {
      panel?.remove();
      panel = undefined;
      control?.classList.remove('ant-select-open');
      control?.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      if (!control || panel || options.length === 0) return;
      const rect = control.getBoundingClientRect();
      panel = document.createElement('div');
      panel.className = 'ant-select-dropdown ui-agent-static-select-dropdown';
      panel.setAttribute('data-ui-agent-static-interaction', 'true');
      Object.assign(panel.style, {
        position: 'fixed', left: `${rect.left}px`, top: `${rect.bottom + 4}px`,
        width: `${Math.max(rect.width, 160)}px`, zIndex: '2147483646', padding: '4px',
        background: '#fff', borderRadius: '8px', boxShadow: '0 6px 16px rgba(0,0,0,.12)'
      });
      for (const option of options) {
        const item = document.createElement('div');
        item.className = 'ant-select-item ant-select-item-option';
        item.setAttribute('data-ui-agent-option', option);
        item.textContent = option;
        Object.assign(item.style, { padding: '5px 12px', lineHeight: '22px', borderRadius: '4px', cursor: 'pointer' });
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(0,0,0,.04)'; });
        item.addEventListener('mouseleave', () => { item.style.background = ''; });
        item.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (display) {
            display.textContent = option;
            display.classList.remove('ant-select-selection-placeholder');
            display.classList.add('ant-select-selection-item');
          }
          close();
        });
        panel.appendChild(item);
      }
      document.body.appendChild(panel);
      control.classList.add('ant-select-open');
      control.setAttribute('aria-expanded', 'true');
    };
    const toggle = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (panel) close(); else open();
    };
    const outside = (event: Event) => {
      if (panel && event.target instanceof Node && !root.contains(event.target) && !panel.contains(event.target)) close();
    };

    return {
      mount: () => {
        close();
        control?.addEventListener('click', toggle);
        document.addEventListener('click', outside);
      },
      unmount: () => {
        close();
        control?.removeEventListener('click', toggle);
        document.removeEventListener('click', outside);
      }
    };
  }

  private findComponentTemplate(target: HTMLElement, component: string): HTMLElement | undefined {
    const semanticType = component === 'select' ? 'select'
      : component === 'input' ? 'input'
        : component === 'button' ? 'button'
          : undefined;
    if (!semanticType) return undefined;
    const fieldSelector = `[data-ui-component="form-field-${semanticType}"]`;
    const componentSelector = `[data-ui-component$="${semanticType}"]`;
    const scopes = [target, target.parentElement, target.closest<HTMLElement>('form'), document.body]
      .filter((scope, index, values): scope is HTMLElement => Boolean(scope) && values.indexOf(scope) === index);
    for (const scope of scopes) {
      if (target.matches(fieldSelector)) return target;
      const field = [...scope.querySelectorAll<HTMLElement>(fieldSelector)].at(-1);
      if (field) return field;
      if (target.matches(componentSelector)) return target;
      const componentNode = [...scope.querySelectorAll<HTMLElement>(componentSelector)].at(-1);
      if (componentNode) return componentNode;
    }
    return undefined;
  }

  private cloneComponentTemplate(
    template: HTMLElement,
    component: string,
    props: { label?: string; text?: string; placeholder?: string; options?: string[]; href?: string }
  ): HTMLElement {
    const clone = template.cloneNode(true) as HTMLElement;
    this.sanitizeClonedTree(clone);
    clone.setAttribute('data-ui-agent-template-source', template.getAttribute('data-ui-component') ?? component);
    if (props.label) {
      const label = clone.querySelector<HTMLElement>('.ant-form-item-label label, label');
      if (label) label.textContent = props.label;
    }
    if (component === 'select') {
      const placeholder = props.placeholder ?? (props.label ? `请选择${props.label}` : '请选择');
      const display = clone.querySelector<HTMLElement>('.ant-select-selection-placeholder, .ant-select-selection-item');
      if (display) display.textContent = placeholder;
      const input = clone.querySelector<HTMLInputElement>('input[role="combobox"], input');
      if (input) input.setAttribute('aria-label', props.label ?? placeholder);
      clone.setAttribute('data-ui-agent-options', JSON.stringify(props.options ?? []));
    } else if (component === 'input') {
      const input = clone.matches('input') ? clone as HTMLInputElement : clone.querySelector<HTMLInputElement>('input, textarea');
      if (input) input.placeholder = props.placeholder ?? '';
    } else if (component === 'button') {
      const label = clone.querySelector<HTMLElement>('span') ?? clone;
      label.textContent = props.text ?? '按钮';
    }
    return clone;
  }

  private contentAction(node: HTMLElement, next: string): Action {
    const input = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
    const previous = input ? node.value : node.textContent ?? '';
    return {
      apply: () => { if (input) node.value = next; else node.textContent = next; },
      revert: () => { if (input) node.value = previous; else node.textContent = previous; }
    };
  }

  private styleAction(node: HTMLElement, styles: Record<string, string>): Action {
    const previous = Object.fromEntries(Object.keys(styles).map(property => [property, node.style.getPropertyValue(this.cssName(property))]));
    const set = (values: Record<string, string>) => Object.entries(values).forEach(([property, value]) => node.style.setProperty(this.cssName(property), value));
    return { apply: () => set(styles), revert: () => set(previous) };
  }

  private removeAction(node: HTMLElement): Action {
    const parent = node.parentNode;
    const next = node.nextSibling;
    if (!parent) throw new Error('目标元素已不在页面中');
    return { apply: () => node.remove(), revert: () => parent.insertBefore(node, next) };
  }

  private moveAction(node: HTMLElement, anchor: HTMLElement, position: 'before' | 'after' | 'insideStart' | 'insideEnd'): Action {
    const oldParent = node.parentNode;
    const oldNext = node.nextSibling;
    if (!oldParent) throw new Error('移动元素已不在页面中');
    return { apply: () => this.insertAt(node, anchor, position), revert: () => oldParent.insertBefore(node, oldNext) };
  }

  private visualStateAction(operation: Extract<UIChangeOperation, { type: 'setVisualState' }>, node: HTMLElement): Action {
    if (operation.state === 'disabled') {
      const previous = node.hasAttribute('disabled');
      return { apply: () => node.toggleAttribute('disabled', operation.value), revert: () => node.toggleAttribute('disabled', previous) };
    }
    if (operation.state === 'selected') {
      const previous = node.getAttribute('aria-selected');
      return { apply: () => node.setAttribute('aria-selected', String(operation.value)), revert: () => previous === null ? node.removeAttribute('aria-selected') : node.setAttribute('aria-selected', previous) };
    }
    const panel = document.createElement('div');
    panel.setAttribute('data-ui-agent-added', 'true');
    const panelId = `added-${crypto.randomUUID()}`;
    panel.setAttribute(ownAttribute, panelId);
    panel.className = 'ui-agent-static-dropdown';
    Object.assign(panel.style, { position: 'absolute', zIndex: '999999', minWidth: `${Math.max(140, node.getBoundingClientRect().width)}px`, background: '#fff', border: '1px solid #d9d9d9', borderRadius: '6px', boxShadow: '0 6px 16px rgba(0,0,0,.12)', padding: '4px', marginTop: '4px' });
    for (const option of operation.options ?? ['选项 A', '选项 B']) {
      const item = document.createElement('div'); item.textContent = option; Object.assign(item.style, { padding: '6px 10px' }); panel.appendChild(item);
    }
    return {
      apply: () => { if (operation.value) { node.insertAdjacentElement('afterend', panel); this.elements.set(panelId, panel); this.addedIds.add(panelId); } },
      revert: () => { panel.remove(); this.addedIds.delete(panelId); }
    };
  }

  private createComponent(component: string, props: { label?: string; text?: string; placeholder?: string; options?: string[]; href?: string }): HTMLElement {
    const common = { height: '32px', boxSizing: 'border-box', font: '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' };
    if (component === 'button') {
      const node = document.createElement('button'); node.type = 'button'; node.textContent = props.text ?? '按钮';
      Object.assign(node.style, common, { padding: '0 15px', color: '#fff', background: '#1677ff', border: '1px solid #1677ff', borderRadius: '6px', cursor: 'default' }); return node;
    }
    if (component === 'link') { const node = document.createElement('a'); node.textContent = props.text ?? '链接'; node.href = props.href ?? '#'; node.style.color = '#1677ff'; return node; }
    if (component === 'input') { const node = document.createElement('input'); node.placeholder = props.placeholder ?? '请输入'; Object.assign(node.style, common, { width: '180px', padding: '4px 11px', border: '1px solid #d9d9d9', borderRadius: '6px' }); return node; }
    if (component === 'select') {
      const node = document.createElement('select'); Object.assign(node.style, common, { minWidth: '160px', padding: '0 11px', border: '1px solid #d9d9d9', borderRadius: '6px', background: '#fff' });
      const placeholder = document.createElement('option'); placeholder.textContent = props.placeholder ?? '请选择'; placeholder.value = ''; node.appendChild(placeholder);
      for (const value of props.options ?? []) { const option = document.createElement('option'); option.textContent = value; option.value = value; node.appendChild(option); } return node;
    }
    if (component === 'checkboxGroup' || component === 'radioGroup') {
      const wrapper = document.createElement('span'); Object.assign(wrapper.style, { display: 'inline-flex', gap: '12px', alignItems: 'center' });
      for (const [index, value] of (props.options ?? []).entries()) { const label = document.createElement('label'); const input = document.createElement('input'); input.type = component === 'checkboxGroup' ? 'checkbox' : 'radio'; input.name = `ui-agent-${component}-${index}`; label.append(input, document.createTextNode(` ${value}`)); wrapper.appendChild(label); } return wrapper;
    }
    const node = document.createElement('span'); node.textContent = props.text ?? '说明文字'; return node;
  }

  private reuseNearbyStyle(node: HTMLElement, target: HTMLElement, component: string): void {
    const selector = component === 'button'
      ? 'button,[data-ui-component$="button"]'
      : component === 'select'
        ? 'select,[data-ui-component$="select"]'
        : component === 'input'
          ? 'input,[data-ui-component$="input"]'
          : undefined;
    if (!selector) return;
    const scope = target.parentElement ?? document.body;
    const template = (target.matches(selector) ? target : scope.querySelector(selector)) as HTMLElement | null;
    if (!template) return;
    const computed = getComputedStyle(template);
    for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'color', 'backgroundColor', 'border', 'borderRadius', 'height', 'padding', 'boxShadow'] as const) {
      const value = computed[property];
      if (value) node.style[property] = value;
    }
    node.setAttribute('data-ui-agent-style-source', template.getAttribute('data-ui-component') ?? template.tagName.toLowerCase());
  }

  private insertAt(node: HTMLElement, target: HTMLElement, position: 'before' | 'after' | 'insideStart' | 'insideEnd') {
    if (position === 'before') target.before(node);
    else if (position === 'after') target.after(node);
    else if (position === 'insideStart') target.prepend(node);
    else target.append(node);
  }

  private showOverlay(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    Object.assign(this.overlay.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  private cssName(property: string) { return property.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`); }
}
