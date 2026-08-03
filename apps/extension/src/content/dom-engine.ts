import {
  PROTOCOL_VERSION,
  type ChangePlan,
  type ContextScope,
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
interface StaticSelectInteraction {
  mount(): void;
  unmount(): void;
  setOpen(value: boolean): void;
  isOpen(): boolean;
  setSelected(options: string[], value: boolean): void;
  isSelected(options: string[]): boolean;
}

const ownAttribute = 'data-ui-agent-id';
const styleProperties = [
  'color', 'backgroundColor', 'fontSize', 'fontWeight', 'display', 'flexDirection', 'gap',
  'padding', 'margin', 'border', 'borderRadius', 'width', 'height', 'gridTemplateColumns',
  'alignItems', 'justifyContent'
] as const;
const appearanceStyleProperties = [
  'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight',
  'letterSpacing', 'textDecoration', 'textAlign', 'verticalAlign', 'display',
  'padding', 'margin', 'border', 'borderRadius', 'boxShadow', 'opacity',
  'height', 'minHeight', 'minWidth'
] as const;
const safeContextAttributes = new Set([
  'aria-label', 'aria-selected', 'aria-expanded', 'aria-checked', 'aria-disabled', 'disabled', 'role', 'type',
  'placeholder', 'title', 'href', 'data-ui-component', 'data-ui-agent-variant',
  'data-ui-agent-options', 'data-ui-agent-selected-options', 'data-ui-source-id'
]);
const forbiddenCloneTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED']);

export class DomEngine {
  private selected: HTMLElement | null = null;
  private selectionVersion = 0;
  private pageRevision = 0;
  private readonly elements = new Map<string, HTMLElement>();
  private readonly addedIds = new Set<string>();
  private readonly undoStack: Transaction[] = [];
  private readonly redoStack: Transaction[] = [];
  private readonly selectInteractions = new WeakMap<HTMLElement, StaticSelectInteraction>();
  private overlay: HTMLDivElement;
  private overlayEnabled = false;
  private lastContext: SelectedContext | null = null;

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

  context(scopes?: ContextScope[], targetNodeIds: string[] = []): SelectedContext {
    if (!this.selected) throw new Error('请先选择页面元素');
    if (!this.selected.isConnected) {
      if (!this.lastContext) throw new Error('选中元素已失效，请重新选择');
      this.lastContext = {
        ...this.lastContext,
        pageRevision: this.pageRevision,
        page: { title: document.title, url: location.href, viewportWidth: innerWidth, viewportHeight: innerHeight }
      };
      return this.lastContext;
    }
    const selected = this.reference(this.selected);
    const parent = this.selected.parentElement;
    if (!parent) throw new Error('选中元素没有可编辑父容器');
    const parentStyle = getComputedStyle(parent);
    const selectedStyle = getComputedStyle(this.selected);
    const visibleStyle = Object.fromEntries(styleProperties.map(name => [name, selectedStyle[name]]));
    const requestedScopes = new Set(scopes ?? [
      'siblings', 'visibleStyles', 'reusableStructures', 'elementFacts', 'sessionChanges'
    ] satisfies ContextScope[]);
    const progressive = scopes !== undefined;
    const treeBudget = { remaining: progressive ? 30 : 80 };
    const localScopeRoot = this.localScopeRoot(this.selected);
    const factScopeRoot = this.factScopeRoot(localScopeRoot);
    const elementIndex = this.collectElementIndex(factScopeRoot);
    const reusableTrees = requestedScopes.has('reusableStructures')
      ? this.findReusableRoots(localScopeRoot)
        .slice(0, 3)
        .map(element => this.describeTree(element, 0, treeBudget))
      : [];
    const selectedTree = this.describeTree(
      progressive ? this.selected : localScopeRoot,
      0,
      treeBudget,
      progressive ? 2 : 5
    );
    const siblings = requestedScopes.has('siblings') && !requestedScopes.has('elementFacts')
      ? [...parent.children]
        .filter(node => node !== this.selected && node instanceof HTMLElement && !node.hasAttribute('data-ui-agent-overlay'))
        .slice(0, 8)
        .map(node => this.describe(node as HTMLElement))
      : [];
    this.lastContext = {
      protocolVersion: PROTOCOL_VERSION,
      selectionVersion: this.selectionVersion,
      pageRevision: this.pageRevision,
      page: { title: document.title, url: location.href, viewportWidth: innerWidth, viewportHeight: innerHeight },
      selected,
      selectedTree,
      reusableTrees,
      parent: { tag: parent.tagName.toLowerCase(), display: parentStyle.display, flexDirection: parentStyle.flexDirection, gap: parentStyle.gap },
      siblings,
      visibleStyle: requestedScopes.has('visibleStyles') ? visibleStyle : {},
      addedElements: requestedScopes.has('sessionChanges')
        ? [...this.addedIds]
          .map(id => this.elements.get(id))
          .filter((element): element is HTMLElement => Boolean(element?.isConnected))
          .map(element => this.describe(element, element.getAttribute(ownAttribute) ?? undefined))
        : [],
      addedTrees: requestedScopes.has('sessionChanges')
        ? [...this.addedIds]
          .map(id => this.elements.get(id))
          .filter((element): element is HTMLElement => Boolean(element?.isConnected) && element !== this.selected && treeBudget.remaining > 0)
          .map(element => this.describeTree(element, 0, treeBudget))
        : [],
      elementFacts: requestedScopes.has('elementFacts')
        ? this.collectElementFacts(factScopeRoot)
        : undefined,
      contextScopes: [...requestedScopes],
      elementIndex,
      elementStyles: requestedScopes.has('visibleStyles') && targetNodeIds.length > 0
        ? this.collectElementStyles(factScopeRoot, targetNodeIds)
        : undefined,
      contextTargetIds: [...new Set(targetNodeIds)].slice(0, 8)
    };
    return this.lastContext;
  }

  applyPlan(plan: ChangePlan, confirmedExistingRemoval: boolean): ExecutionReceipt {
    const context = this.context();
    validatePlan(plan, context);
    if (plan.requiresConfirmation && !confirmedExistingRemoval) throw new Error('删除已有元素前必须由用户确认');
    const applied: Action[] = [];
    const operationReceipts: ExecutionReceipt['operations'] = [];
    const resultRefs = new Map<string, HTMLElement>();
    let currentOperation: UIChangeOperation | undefined;
    try {
      for (const operation of plan.operations) {
        currentOperation = operation;
        const action = this.actionFor(operation, resultRefs);
        applied.push(action);
        action.apply();
        operationReceipts.push({ operationId: operation.operationId, status: 'applied', verified: false });
      }
      operationReceipts.forEach((receipt, index) => {
        const operation = plan.operations[index];
        receipt.verified = Boolean(operation && this.verifyAppliedOperation(operation, resultRefs));
        if (operation?.type === 'cloneSubtree' || operation?.type === 'addComponent') {
          const resultRef = operation.type === 'cloneSubtree'
            ? operation.resultRef
            : operation.resultRef ?? `operation:${operation.operationId}`;
          receipt.resultElementId = resultRefs.get(resultRef)?.getAttribute(ownAttribute) ?? undefined;
        }
      });
    } catch (error) {
      for (const action of [...applied].reverse()) {
        try { action.revert(); } catch { /* Preserve the original execution error. */ }
      }
      operationReceipts.forEach(receipt => { receipt.status = 'rolledBack'; });
      if (currentOperation && !operationReceipts.some(receipt => receipt.operationId === currentOperation?.operationId)) {
        operationReceipts.push({
          operationId: currentOperation.operationId,
          status: 'failed',
          verified: false,
          errorCode: 'EXECUTION_ERROR',
          errorMessage: error instanceof Error ? error.message : 'DOM 操作失败'
        });
      }
      this.refreshOverlay();
      return {
        protocolVersion: PROTOCOL_VERSION,
        planId: plan.planId,
        success: false,
        pageRevision: this.pageRevision,
        appliedOperationIds: [],
        operations: operationReceipts,
        error: error instanceof Error ? error.message : 'DOM 操作失败'
      };
    }
    const transaction = { planId: plan.planId, actions: applied };
    this.undoStack.push(transaction);
    this.redoStack.length = 0;
    this.pageRevision += 1;
    this.refreshOverlay();
    return {
      protocolVersion: PROTOCOL_VERSION, planId: plan.planId, success: true, pageRevision: this.pageRevision,
      appliedOperationIds: plan.operations.map(operation => operation.operationId),
      operations: operationReceipts
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

  private factScopeRoot(element: HTMLElement): HTMLElement {
    let scope = element;
    for (let depth = 0; depth < 2; depth += 1) {
      const parent = scope.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      scope = parent;
      if (scope.children.length > 1) break;
    }
    return scope;
  }

  private findReusableRoots(scope: HTMLElement): HTMLElement[] {
    if (scope.matches('tr,[role="row"],li')) return [];
    const rows = [...scope.querySelectorAll<HTMLElement>('tr,[role="row"]')];
    if (rows.length > 0) return [rows.at(-1)!];
    const listItems = [...scope.querySelectorAll<HTMLElement>('li')];
    return listItems.length > 1 ? [listItems.at(-1)!] : [];
  }

  private describeTree(element: HTMLElement, depth: number, budget: { remaining: number }, maxDepth = 5): DomTreeNode {
    budget.remaining = Math.max(0, budget.remaining - 1);
    const attributes = Object.fromEntries(
      [...element.attributes]
        .filter(attribute => safeContextAttributes.has(attribute.name))
        .map(attribute => [attribute.name, attribute.value.slice(0, 300)])
    );
    if (!attributes['data-ui-component']) {
      const inferredComponent = this.inferComponent(element);
      if (inferredComponent) attributes['data-ui-component'] = inferredComponent;
    }
    const directText = [...element.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const children: DomTreeNode[] = [];
    if (depth < maxDepth) {
      for (const child of [...element.children]) {
        if (budget.remaining <= 0) break;
        if (child instanceof HTMLElement && !child.hasAttribute('data-ui-agent-overlay')) {
          children.push(this.describeTree(child, depth + 1, budget, maxDepth));
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

  private inferComponent(element: HTMLElement): string | undefined {
    if (element.classList.contains('ant-tag')) return 'tag';
    if (element.classList.contains('ant-alert')) return 'alert';
    if (element.classList.contains('ant-select')) return 'select';
    if (element.classList.contains('ant-btn')) return 'button';
    return undefined;
  }

  private collectElementFacts(root: HTMLElement) {
    const facts: NonNullable<SelectedContext['elementFacts']> = [];
    const visit = (element: HTMLElement, parentId?: string) => {
      if (facts.length >= 120) return;
      const id = this.ensureId(element);
      const resolvedParentId = parentId
        ?? (element.parentElement && !element.parentElement.hasAttribute('data-ui-agent-overlay')
          ? this.ensureId(element.parentElement)
          : undefined);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const semanticRole = element.getAttribute('data-ui-component') ?? this.inferComponent(element);
      const directText = [...element.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const descriptiveText = directText
        || (element.children.length === 0 || semanticRole
          ? element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || ''
          : '');
      facts.push({
        id,
        tag: element.tagName.toLowerCase(),
        parentId: resolvedParentId,
        index: element.parentElement ? [...element.parentElement.children].indexOf(element) : 0,
        semanticRole,
        text: descriptiveText.trim().slice(0, 300),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        layout: {
          display: style.display,
          flexDirection: style.flexDirection,
          gridTemplateColumns: style.gridTemplateColumns,
          gap: style.gap
        }
      });
      for (const child of [...element.children]) {
        if (child instanceof HTMLElement && !child.hasAttribute('data-ui-agent-overlay')) visit(child, id);
      }
    };
    visit(root);
    for (const id of this.addedIds) {
      const element = this.elements.get(id);
      if (element?.isConnected && !root.contains(element) && facts.length < 120) visit(element);
    }
    return facts;
  }

  private collectElementIndex(root: HTMLElement) {
    const entries: NonNullable<SelectedContext['elementIndex']> = [];
    const visit = (element: HTMLElement, parentId?: string) => {
      if (entries.length >= 40) return;
      const id = this.ensureId(element);
      const semanticRole = element.getAttribute('data-ui-component') ?? this.inferComponent(element);
      const directText = [...element.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const text = directText
        || (element.children.length === 0 || semanticRole
          ? element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || ''
          : '');
      const isSessionAdded = this.addedIds.has(id) || element.hasAttribute('data-ui-agent-added');
      const interactive = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName);
      const meaningful = element === root
        || element === this.selected
        || Boolean(semanticRole)
        || Boolean(directText)
        || interactive
        || isSessionAdded;
      if (meaningful) {
        entries.push({
          id,
          tag: element.tagName.toLowerCase(),
          parentId,
          semanticRole,
          text: text.trim().slice(0, 120),
          isSessionAdded
        });
      }
      const indexedParentId = meaningful ? id : parentId;
      for (const child of [...element.children]) {
        if (child instanceof HTMLElement && !child.hasAttribute('data-ui-agent-overlay')) visit(child, indexedParentId);
      }
    };
    visit(root);
    for (const id of this.addedIds) {
      const element = this.elements.get(id);
      if (element?.isConnected && !root.contains(element) && entries.length < 60) visit(element);
    }
    return entries;
  }

  private collectElementStyles(root: HTMLElement, targetNodeIds: string[]) {
    const requested = [...new Set(targetNodeIds)].slice(0, 8);
    return requested.flatMap(id => {
      const element = this.elements.get(id);
      const allowed = element?.isConnected && (root.contains(element) || this.addedIds.has(id));
      if (!element || !allowed) return [];
      const computed = getComputedStyle(element);
      return [{
        id,
        styles: Object.fromEntries(appearanceStyleProperties.map(property => [property, computed[property]]))
      }];
    });
  }

  private describe(element: HTMLElement, knownId?: string): ElementRef {
    const rect = element.getBoundingClientRect();
    return {
      id: knownId ?? element.getAttribute(ownAttribute) ?? `read-${crypto.randomUUID()}`,
      sourceId: element.getAttribute('data-ui-source-id') ?? undefined,
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
      case 'copyStyles': return this.copyStylesAction(
        this.resolve(operation.source, resultRefs),
        this.resolve(operation.target, resultRefs)
      );
      case 'removeElement': return this.removeAction(this.resolve(operation.target, resultRefs));
      case 'moveElement': return this.moveAction(this.resolve(operation.target, resultRefs), this.resolve(operation.anchor, resultRefs), operation.position);
      case 'setVisualState': return this.visualStateAction(operation, this.resolve(operation.target, resultRefs));
    }
  }

  private verifyAppliedOperation(operation: UIChangeOperation, resultRefs: Map<string, HTMLElement>): boolean {
    try {
      if (operation.type === 'cloneSubtree') {
        const clone = resultRefs.get(operation.resultRef);
        if (!clone?.isConnected) return false;
        const placement = this.normalizeClonePlacement(
          this.resolve(operation.source, resultRefs),
          this.resolve(operation.anchor, resultRefs),
          operation.position
        );
        return this.isAtPlacement(clone, placement.anchor, placement.position);
      }
      if (operation.type === 'addComponent') {
        return Boolean(resultRefs.get(operation.resultRef ?? `operation:${operation.operationId}`)?.isConnected);
      }
      const node = this.resolve(operation.target, resultRefs);
      if (operation.type === 'updateContent') {
        const actual = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : node.textContent ?? '';
        return actual === operation.text;
      }
      if (operation.type === 'updateStyle') {
        return Object.entries(operation.styles).every(([property, value]) => {
          const cssProperty = this.cssName(property);
          const probe = document.createElement('div');
          probe.style.setProperty(cssProperty, value);
          return node.style.getPropertyValue(cssProperty) === probe.style.getPropertyValue(cssProperty);
        });
      }
      if (operation.type === 'copyStyles') {
        const sourceStyle = getComputedStyle(this.resolve(operation.source, resultRefs));
        return appearanceStyleProperties.every(property =>
          node.style.getPropertyValue(this.cssName(property)) === sourceStyle[property]
        );
      }
      if (operation.type === 'removeElement') return !node.isConnected;
      if (operation.type === 'moveElement') return node.isConnected;
      if (operation.state === 'disabled') return node.hasAttribute('disabled') === operation.value;
      if (operation.state === 'selected') return this.isVisualSelectionApplied(node, operation.options ?? [], operation.value);
      const selectInteraction = this.findSelectInteraction(node);
      if (selectInteraction) return selectInteraction.isOpen() === operation.value;
      const expandedNode = node.matches('[aria-expanded]') ? node : node.querySelector<HTMLElement>('[aria-expanded]');
      return expandedNode?.getAttribute('aria-expanded') === String(operation.value);
    } catch {
      return false;
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

    throw new Error(`${source.tagName.toLowerCase()} 无法按计划插入到 ${anchor.tagName.toLowerCase()} 的 ${position}，需要重新规划合法锚点`);
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
    const template = operation.component === 'tag' && operation.props.label
      ? undefined
      : this.findComponentTemplate(target, operation.component);
    const node = template
      ? this.cloneComponentTemplate(template, operation.component, operation.props)
      : this.createComponent(operation.component, operation.props);
    this.applyComponentVariant(node, operation.component, operation.props.variant);
    if (!template) this.reuseNearbyStyle(node, target, operation.component);
    const insertion = template && target.contains(template)
      ? { target: template, position: 'after' as const }
      : { target, position: operation.position };
    const staticInteraction = template && operation.component === 'select'
      ? this.createStaticSelectInteraction(node, operation.props.options ?? [])
      : undefined;
    if (staticInteraction) {
      this.selectInteractions.set(node, staticInteraction);
      const control = node.matches('.ant-select') ? node : node.querySelector<HTMLElement>('.ant-select');
      if (control) this.selectInteractions.set(control, staticInteraction);
    }
    const newId = `added-${crypto.randomUUID()}`;
    node.setAttribute(ownAttribute, newId);
    node.setAttribute('data-ui-agent-added', 'true');
    const insert = () => {
      this.insertAt(node, insertion.target, insertion.position);
      this.elements.set(newId, node);
      this.addedIds.add(newId);
      resultRefs.set(operation.resultRef ?? `operation:${operation.operationId}`, node);
      staticInteraction?.mount();
    };
    return {
      apply: insert,
      revert: () => {
        staticInteraction?.unmount();
        node.remove();
        this.addedIds.delete(newId);
        resultRefs.delete(operation.resultRef ?? `operation:${operation.operationId}`);
      }
    };
  }

  private createStaticSelectInteraction(root: HTMLElement, options: string[]): StaticSelectInteraction {
    const control = root.matches('.ant-select') ? root : root.querySelector<HTMLElement>('.ant-select');
    const display = this.findSelectDisplay(root);
    const selectedOptions = new Set<string>();
    let panel: HTMLDivElement | undefined;

    const position = () => {
      if (!control || !panel) return;
      const rect = control.getBoundingClientRect();
      const width = Math.max(rect.width, 160);
      panel.style.width = `${width}px`;
      const panelRect = panel.getBoundingClientRect();
      const viewportPadding = 8;
      const maxLeft = Math.max(viewportPadding, innerWidth - width - viewportPadding);
      const left = Math.min(Math.max(rect.left, viewportPadding), maxLeft);
      const openAbove = rect.bottom + 4 + panelRect.height > innerHeight - viewportPadding
        && rect.top - panelRect.height - 4 >= viewportPadding;
      const top = openAbove ? rect.top - panelRect.height - 4 : rect.bottom + 4;
      panel.style.left = `${left}px`;
      panel.style.top = `${Math.max(viewportPadding, top)}px`;
      panel.classList.toggle('ant-select-dropdown-placement-topLeft', openAbove);
      panel.classList.toggle('ant-select-dropdown-placement-bottomLeft', !openAbove);
    };
    const close = () => {
      panel?.remove();
      panel = undefined;
      control?.classList.remove('ant-select-open');
      control?.setAttribute('aria-expanded', 'false');
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
    const open = () => {
      if (!control || panel || options.length === 0) return;
      panel = document.createElement('div');
      panel.className = 'ant-select-dropdown ant-select-dropdown-placement-bottomLeft ui-agent-static-select-dropdown';
      const themeClasses = [...control.classList].filter(className =>
        className === 'ant-select-css-var'
        || className.startsWith('css-var-')
        || className.startsWith('css-dev-only-do-not-override-')
      );
      panel.classList.add(...themeClasses);
      panel.setAttribute('data-ui-agent-static-interaction', 'true');
      Object.assign(panel.style, {
        position: 'fixed', zIndex: '2147483646'
      });
      const virtualList = document.createElement('div');
      virtualList.className = 'rc-virtual-list';
      const holder = document.createElement('div');
      holder.className = 'rc-virtual-list-holder';
      const optionList = document.createElement('div');
      optionList.className = 'rc-virtual-list-holder-inner';
      optionList.setAttribute('role', 'listbox');
      for (const option of options) {
        const item = document.createElement('div');
        item.className = 'ant-select-item ant-select-item-option';
        item.setAttribute('data-ui-agent-option', option);
        item.setAttribute('role', 'option');
        const selected = selectedOptions.has(option);
        item.setAttribute('aria-selected', String(selected));
        item.classList.toggle('ant-select-item-option-selected', selected);
        const content = document.createElement('div');
        content.className = 'ant-select-item-option-content';
        content.textContent = option;
        item.appendChild(content);
        item.addEventListener('mouseenter', () => item.classList.add('ant-select-item-option-active'));
        item.addEventListener('mouseleave', () => item.classList.remove('ant-select-item-option-active'));
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
        optionList.appendChild(item);
      }
      holder.appendChild(optionList);
      virtualList.appendChild(holder);
      panel.appendChild(virtualList);
      document.body.appendChild(panel);
      position();
      window.addEventListener('resize', position);
      window.addEventListener('scroll', position, true);
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
      },
      setOpen: value => { if (value) open(); else close(); },
      isOpen: () => Boolean(panel),
      setSelected: (values, value) => {
        for (const option of values) {
          if (value) selectedOptions.add(option);
          else selectedOptions.delete(option);
          const item = [...(panel?.querySelectorAll<HTMLElement>('[data-ui-agent-option]') ?? [])]
            .find(candidate => candidate.getAttribute('data-ui-agent-option') === option);
          item?.setAttribute('aria-selected', String(value));
          item?.classList.toggle('ant-select-item-option-selected', value);
        }
        const selected = [...selectedOptions][0];
        root.setAttribute('data-ui-agent-selected-options', JSON.stringify([...selectedOptions]));
        if (display && selected) {
          display.textContent = selected;
          display.classList.remove('ant-select-selection-placeholder');
          display.classList.add('ant-select-selection-item');
        }
      },
      isSelected: values => values.every(value => selectedOptions.has(value))
    };
  }

  private findComponentTemplate(target: HTMLElement, component: string): HTMLElement | undefined {
    const semanticType = component === 'select' ? 'select'
      : component === 'input' ? 'input'
        : component === 'button' ? 'button'
          : component === 'tag' ? 'tag'
            : component === 'alert' ? 'alert'
          : undefined;
    if (!semanticType) return undefined;
    const fieldSelector = `[data-ui-component="form-field-${semanticType}"]`;
    const classSelector = component === 'tag' ? '.ant-tag'
      : component === 'alert' ? '.ant-alert'
        : '';
    const componentSelector = `[data-ui-component$="${semanticType}"]${classSelector ? `,${classSelector}` : ''}`;
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
    props: { label?: string; text?: string; placeholder?: string; options?: string[]; href?: string; variant?: string }
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
      const display = this.findSelectDisplay(clone);
      if (display) display.textContent = placeholder;
      const input = clone.querySelector<HTMLInputElement>('input[role="combobox"], input');
      if (input) {
        input.setAttribute('aria-label', props.label ?? placeholder);
        input.setAttribute('placeholder', placeholder);
      }
      clone.setAttribute('data-ui-agent-options', JSON.stringify(props.options ?? []));
    } else if (component === 'input') {
      const input = clone.matches('input') ? clone as HTMLInputElement : clone.querySelector<HTMLInputElement>('input, textarea');
      if (input) input.placeholder = props.placeholder ?? '';
    } else if (component === 'button') {
      const label = clone.querySelector<HTMLElement>('span') ?? clone;
      label.textContent = props.text ?? '按钮';
    } else if (component === 'tag') {
      clone.textContent = props.text ?? '标签';
    } else if (component === 'alert') {
      const message = clone.querySelector<HTMLElement>('.ant-alert-message') ?? clone;
      message.textContent = props.text ?? '提示';
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

  private copyStylesAction(source: HTMLElement, target: HTMLElement): Action {
    const styles = Object.fromEntries(appearanceStyleProperties.map(property => [property, getComputedStyle(source)[property]]));
    return this.styleAction(target, styles);
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
      const values = operation.options ?? [];
      const interaction = this.findSelectInteraction(node);
      if (interaction) {
        const previous = interaction.isSelected(values);
        return {
          apply: () => interaction.setSelected(values, operation.value),
          revert: () => interaction.setSelected(values, previous)
        };
      }
      const candidates = this.findOptionElements(node, values);
      const previous = candidates.map(candidate => ({
        candidate,
        ariaSelected: candidate.getAttribute('aria-selected'),
        input: candidate.querySelector<HTMLInputElement>('input'),
        checked: candidate.querySelector<HTMLInputElement>('input')?.checked
      }));
      const set = (value: boolean) => {
        for (const candidate of candidates) {
          candidate.setAttribute('aria-selected', String(value));
          candidate.classList.toggle('ant-select-item-option-selected', value);
          const input = candidate.matches('input') ? candidate as HTMLInputElement : candidate.querySelector<HTMLInputElement>('input');
          if (input) {
            input.checked = value;
            input.setAttribute('aria-checked', String(value));
          }
        }
      };
      return {
        apply: () => set(operation.value),
        revert: () => previous.forEach(item => {
          if (item.ariaSelected === null) item.candidate.removeAttribute('aria-selected');
          else item.candidate.setAttribute('aria-selected', item.ariaSelected);
          item.candidate.classList.toggle('ant-select-item-option-selected', item.ariaSelected === 'true');
          if (item.input && item.checked !== undefined) item.input.checked = item.checked;
        })
      };
    }
    const existingInteraction = this.findSelectInteraction(node);
    if (existingInteraction) {
      const previous = existingInteraction.isOpen();
      return {
        apply: () => existingInteraction.setOpen(operation.value),
        revert: () => existingInteraction.setOpen(previous)
      };
    }
    const selectControl = node.matches('.ant-select') ? node : node.querySelector<HTMLElement>('.ant-select');
    if (selectControl) {
      const interaction = this.createStaticSelectInteraction(node, operation.options ?? []);
      this.selectInteractions.set(node, interaction);
      this.selectInteractions.set(selectControl, interaction);
      return {
        apply: () => {
          interaction.mount();
          interaction.setOpen(operation.value);
        },
        revert: () => interaction.unmount()
      };
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

  private findSelectInteraction(node: HTMLElement): StaticSelectInteraction | undefined {
    const own = this.selectInteractions.get(node);
    if (own) return own;
    const addedRoot = node.closest<HTMLElement>('[data-ui-agent-added]');
    if (addedRoot) {
      const interaction = this.selectInteractions.get(addedRoot);
      if (interaction) return interaction;
    }
    const control = node.matches('.ant-select') ? node : node.querySelector<HTMLElement>('.ant-select');
    return control ? this.selectInteractions.get(control) : undefined;
  }

  private findSelectDisplay(root: HTMLElement): HTMLElement | null {
    if (root.matches('.ant-select-selection-placeholder, .ant-select-selection-item')) return root;
    return root.querySelector<HTMLElement>(
      '.ant-select-selection-placeholder, .ant-select-selection-item, [class*="ant-select-selection-placeholder"], [class*="ant-select-selection-item"]'
    );
  }

  private findOptionElements(node: HTMLElement, values: string[]): HTMLElement[] {
    if (values.length === 0) return [node];
    const candidates = [node, ...node.querySelectorAll<HTMLElement>('label,[role="option"],.ant-select-item-option,input')];
    return candidates.filter(candidate => {
      const text = (candidate.getAttribute('data-ui-agent-option') ?? candidate.textContent ?? '').replace(/\s+/g, ' ').trim();
      return values.includes(text);
    });
  }

  private isVisualSelectionApplied(node: HTMLElement, values: string[], expected: boolean): boolean {
    const interaction = this.findSelectInteraction(node);
    if (interaction) return interaction.isSelected(values) === expected;
    const candidates = this.findOptionElements(node, values);
    if (candidates.length === 0) return false;
    return candidates.every(candidate => {
      const input = candidate.matches('input') ? candidate as HTMLInputElement : candidate.querySelector<HTMLInputElement>('input');
      const selected = input?.checked
        ?? (candidate.getAttribute('aria-selected') === 'true'
          || candidate.classList.contains('ant-select-item-option-selected'));
      return selected === expected;
    });
  }

  private createComponent(component: string, props: { label?: string; text?: string; placeholder?: string; options?: string[]; href?: string; variant?: string }): HTMLElement {
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
    if (component === 'tag') {
      const tag = document.createElement('span');
      tag.className = 'ant-tag';
      tag.textContent = props.text ?? '标签';
      if (!props.label) return tag;
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-ui-component', 'labeled-tag');
      const label = document.createElement('span');
      label.className = 'ant-typography ant-typography-secondary';
      label.textContent = props.label;
      const value = document.createElement('div');
      Object.assign(value.style, { marginTop: '4px' });
      value.appendChild(tag);
      wrapper.append(label, value);
      return wrapper;
    }
    if (component === 'alert') {
      const node = document.createElement('div');
      node.className = 'ant-alert ant-alert-no-icon';
      node.setAttribute('role', 'alert');
      const content = document.createElement('div');
      content.className = 'ant-alert-content';
      const message = document.createElement('div');
      message.className = 'ant-alert-message';
      message.textContent = props.text ?? '提示';
      content.appendChild(message);
      node.appendChild(content);
      return node;
    }
    const node = document.createElement('span'); node.textContent = props.text ?? '说明文字'; return node;
  }

  private applyComponentVariant(node: HTMLElement, component: string, variant?: string): void {
    if (!variant) return;
    node.setAttribute('data-ui-agent-variant', variant);
    if (component === 'button' && variant === 'danger') {
      node.classList.add('ant-btn-dangerous');
      node.classList.remove('ant-btn-default', 'ant-btn-variant-outlined');
      Object.assign(node.style, {
        color: '#fff',
        backgroundColor: '#ff4d4f',
        borderColor: '#ff4d4f'
      });
      return;
    }
    if (component === 'tag') {
      const tag = node.matches('.ant-tag') ? node : node.querySelector<HTMLElement>('.ant-tag');
      if (!tag) return;
      const palette = variant === 'danger'
        ? { color: '#cf1322', backgroundColor: '#fff1f0', borderColor: '#ffa39e' }
        : variant === 'success'
          ? { color: '#389e0d', backgroundColor: '#f6ffed', borderColor: '#b7eb8f' }
          : { color: '#0958d9', backgroundColor: '#e6f4ff', borderColor: '#91caff' };
      Object.assign(tag.style, palette);
      return;
    }
    if (component === 'alert') {
      node.classList.remove('ant-alert-warning', 'ant-alert-error', 'ant-alert-info', 'ant-alert-success');
      const alertType = variant === 'danger' ? 'error' : variant === 'success' ? 'success' : variant === 'warning' ? 'warning' : 'info';
      node.classList.add(`ant-alert-${alertType}`);
      const palette = alertType === 'error'
        ? { backgroundColor: '#fff2f0', borderColor: '#ffccc7' }
        : alertType === 'success'
          ? { backgroundColor: '#f6ffed', borderColor: '#b7eb8f' }
          : alertType === 'warning'
            ? { backgroundColor: '#fffbe6', borderColor: '#ffe58f' }
            : { backgroundColor: '#e6f4ff', borderColor: '#91caff' };
      Object.assign(node.style, {
        ...palette,
        display: 'block',
        padding: '8px 12px',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderRadius: '6px'
      });
    }
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

  private isAtPlacement(
    node: HTMLElement,
    target: HTMLElement,
    position: 'before' | 'after' | 'insideStart' | 'insideEnd'
  ): boolean {
    if (position === 'before') return node.nextElementSibling === target;
    if (position === 'after') return node.previousElementSibling === target;
    if (position === 'insideStart') return target.firstElementChild === node;
    return target.lastElementChild === node;
  }

  private showOverlay(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    Object.assign(this.overlay.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  private cssName(property: string) { return property.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`); }
}
