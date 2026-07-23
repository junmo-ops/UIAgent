import type {
  ChangePlan,
  DomTreeNode,
  NodeTarget,
  SelectedContext,
  UIChangeOperation,
  UiGoal,
  UiIntent
} from '@ui-agent/contracts';

const ALLOWED_STYLES = new Set([
  'color', 'backgroundColor', 'fontSize', 'fontWeight', 'width', 'height',
  'margin', 'marginLeft', 'marginRight', 'marginTop', 'marginBottom',
  'padding', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
  'border', 'borderColor', 'borderRadius', 'display', 'gap', 'opacity',
  'gridTemplateColumns', 'alignItems', 'justifyContent'
]);

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const LAYOUT_STYLES = new Set(['display', 'gridTemplateColumns', 'alignItems', 'justifyContent', 'gap']);
const FORBIDDEN_CLONE_TAGS = new Set(['html', 'body', 'script', 'style', 'iframe', 'object', 'embed']);
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'combobox', 'switch', 'tab']);

export class PolicyError extends Error {
  readonly code = 'POLICY_ERROR';
}

export class IntentCompilationError extends Error {
  readonly code = 'INTENT_COMPILATION_ERROR';
}

export const componentCapabilityRegistry = {
  button: { component: 'button', variants: ['primary', 'danger', 'neutral'], states: ['disabled'] },
  text: { component: 'text', variants: ['neutral'], states: [] },
  link: { component: 'link', variants: ['primary', 'neutral'], states: [] },
  input: { component: 'input', variants: ['neutral'], states: ['disabled'] },
  select: { component: 'select', variants: ['neutral'], states: ['open', 'selected', 'disabled'] },
  checkboxGroup: { component: 'checkboxGroup', variants: ['neutral'], states: ['selected', 'disabled'] },
  radioGroup: { component: 'radioGroup', variants: ['neutral'], states: ['selected', 'disabled'] },
  tag: { component: 'tag', variants: ['danger', 'warning', 'success', 'info', 'neutral'], states: [] },
  alert: { component: 'alert', variants: ['danger', 'warning', 'success', 'info', 'neutral'], states: [] }
} as const;

type ComponentRole = keyof typeof componentCapabilityRegistry;

function isComponentRole(role: UiGoal['role']): role is ComponentRole {
  return role in componentCapabilityRegistry;
}

function operationResultRef(operation: UIChangeOperation): string | undefined {
  if (operation.type === 'cloneSubtree') return operation.resultRef;
  if (operation.type === 'addComponent') return operation.resultRef;
  return undefined;
}

function resultTarget(resultRef: string): NodeTarget {
  return { kind: 'result', resultRef, path: [] };
}

/**
 * Compiles declarative UI goals into an executable plan using a capability
 * registry. It never inspects natural-language keywords or business entities.
 */
export function compilePlanFromIntent(
  plan: ChangePlan & { intent: UiIntent },
  context: SelectedContext
): ChangePlan & { intent: UiIntent } {
  const operations = [...plan.operations];
  const usedOperationIds = new Set(operations.map(operation => operation.operationId));
  const nextOperationId = (goalId: string, suffix: string) => {
    let candidate = `${goalId}-${suffix}`;
    let index = 1;
    while (usedOperationIds.has(candidate)) candidate = `${goalId}-${suffix}-${index++}`;
    usedOperationIds.add(candidate);
    return candidate;
  };

  for (const goal of plan.intent.goals) {
    let producerIndex = goal.resultRef
      ? operations.findIndex(operation => operationResultRef(operation) === goal.resultRef)
      : -1;
    if (goal.action === 'create' && !goal.resultRef) {
      throw new IntentCompilationError(`创建目标 ${goal.goalId} 缺少 resultRef`);
    }
    if (goal.action === 'create' && producerIndex < 0 && goal.resultRef) {
      producerIndex = operations.findIndex(operation =>
        operation.type === 'addComponent' && !operation.resultRef
      );
      const unbound = operations[producerIndex];
      if (unbound?.type === 'addComponent') unbound.resultRef = goal.resultRef;
    }
    if (goal.action === 'create' && producerIndex < 0) {
      throw new IntentCompilationError(`创建目标 ${goal.goalId} 没有对应的结果操作`);
    }

    if (goal.action === 'create' && producerIndex >= 0) {
      const producer = operations[producerIndex]!;
      if (goal.placement && (producer.type === 'addComponent' || producer.type === 'cloneSubtree')) {
        producer.anchor = goal.placement.anchor;
        producer.position = goal.placement.relation;
      }
      if (isComponentRole(goal.role)) {
        const capability = componentCapabilityRegistry[goal.role];
        if (goal.content.variant && !(capability.variants as readonly string[]).includes(goal.content.variant)) {
          throw new IntentCompilationError(`${goal.role} 不支持 ${goal.content.variant} 变体`);
        }
        if (goal.state && !(capability.states as readonly string[]).includes(goal.state.name)) {
          throw new IntentCompilationError(`${goal.role} 不支持 ${goal.state.name} 状态`);
        }
        const props = {
          ...goal.content,
          ...(goal.role === 'select' && goal.content.label && !goal.content.placeholder
            ? { placeholder: `请选择${goal.content.label}` }
            : {})
        };
        if (producer.type === 'addComponent') {
          operations[producerIndex] = {
            ...producer,
            component: capability.component,
            props: { ...producer.props, ...props }
          };
        } else if (producer.type === 'cloneSubtree') {
          operations[producerIndex] = {
            operationId: producer.operationId,
            type: 'addComponent',
            anchor: producer.anchor,
            component: capability.component,
            position: producer.position,
            resultRef: producer.resultRef,
            props
          };
        }
      }
    }

    if (goal.placement?.sameRow && goal.placement.anchor.kind === 'node') {
      const resolvedAnchorFact = context.elementFacts?.find(fact =>
        goal.placement?.anchor.kind === 'node' && fact.id === goal.placement.anchor.nodeId
      );
      const parentFact = context.elementFacts?.find(fact => fact.id === resolvedAnchorFact?.parentId);
      if (parentFact?.layout.display === 'grid') {
        const columns = parentFact.layout.gridTemplateColumns.split(/\s+/).filter(Boolean);
        const siblingCount = context.elementFacts?.filter(fact => fact.parentId === parentFact.id).length ?? 0;
        if (columns.length > 0 && columns.length === siblingCount) {
          const alreadyAdjustsGrid = operations.some(operation =>
            operation.type === 'updateStyle'
            && operation.target.kind === 'node'
            && operation.target.nodeId === parentFact.id
            && operation.styles.gridTemplateColumns
          );
          if (!alreadyAdjustsGrid) {
            operations.push({
              operationId: nextOperationId(goal.goalId, 'layout'),
              type: 'updateStyle',
              target: { kind: 'node', nodeId: parentFact.id },
              styles: { gridTemplateColumns: `repeat(${columns.length + 1}, minmax(0, 1fr))` }
            });
          }
        }
      }
    }

    if (goal.state) {
      if (!goal.resultRef && !goal.target) {
        throw new IntentCompilationError(`状态目标 ${goal.goalId} 缺少 target 或 resultRef`);
      }
      const target = goal.target ?? resultTarget(goal.resultRef!);
      const existingState = operations.find(
        operation => operation.type === 'setVisualState'
          && JSON.stringify(operation.target) === JSON.stringify(target)
          && operation.state === goal.state?.name
      );
      if (existingState?.type === 'setVisualState') {
        existingState.value = goal.state.value;
        existingState.options = goal.state.options;
      } else {
        operations.push({
          operationId: nextOperationId(goal.goalId, 'state'),
          type: 'setVisualState',
          target,
          state: goal.state.name,
          value: goal.state.value,
          options: goal.state.options
        });
      }
    }
  }
  if (operations.length > 12) throw new IntentCompilationError('目标编译后的原子操作超过 12 个');
  return { ...plan, operations };
}

export function intentFromOperations(summary: string, operations: UIChangeOperation[]): UiIntent {
  const goals: UiGoal[] = [];
  for (const operation of operations) {
    if (operation.type === 'addComponent') {
      const resultRef = operation.resultRef ?? `operation:${operation.operationId}`;
      goals.push({
        goalId: `goal-${operation.operationId}`,
        action: 'create',
        role: operation.component,
        resultRef,
        content: { ...operation.props },
        placement: { anchor: operation.anchor, relation: operation.position, strict: true, sameRow: false },
        preserveTexts: []
      });
      continue;
    }
    if (operation.type === 'cloneSubtree') {
      goals.push({
        goalId: `goal-${operation.operationId}`,
        action: 'create',
        role: operation.source.kind === 'node' ? 'row' : 'container',
        resultRef: operation.resultRef,
        content: {},
        placement: { anchor: operation.anchor, relation: operation.position, strict: true, sameRow: false },
        preserveTexts: []
      });
      continue;
    }
    if (operation.type === 'updateContent') {
      goals.push({
        goalId: `goal-${operation.operationId}`,
        action: 'update',
        role: 'text',
        target: operation.target,
        content: { text: operation.text },
        preserveTexts: []
      });
      continue;
    }
    if (operation.type === 'setVisualState') {
      goals.push({
        goalId: `goal-${operation.operationId}`,
        action: 'present',
        role: 'container',
        target: operation.target,
        content: {},
        state: { name: operation.state, value: operation.value, options: operation.options },
        preserveTexts: []
      });
      continue;
    }
    const target = operation.type === 'moveElement' ? operation.target : operation.target;
    goals.push({
      goalId: `goal-${operation.operationId}`,
      action: operation.type === 'removeElement' ? 'remove' : operation.type === 'moveElement' ? 'move' : 'update',
      role: 'container',
      target,
      content: {},
      ...(operation.type === 'moveElement' && {
        placement: { anchor: operation.anchor, relation: operation.position, strict: true, sameRow: false }
      }),
      preserveTexts: []
    });
  }
  return { summary, goals };
}

function indexTrees(trees: DomTreeNode[]): Map<string, DomTreeNode> {
  const nodes = new Map<string, DomTreeNode>();
  const visit = (node: DomTreeNode) => {
    nodes.set(node.id, node);
    node.children.forEach(visit);
  };
  trees.forEach(visit);
  return nodes;
}

function findTreeNode(root: DomTreeNode, id: string): DomTreeNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findTreeNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function isInteractiveSelection(context: SelectedContext): boolean {
  return INTERACTIVE_TAGS.has(context.selected.tag)
    || Boolean(context.selected.role && INTERACTIVE_ROLES.has(context.selected.role));
}

function validateTarget(
  target: NodeTarget,
  nodes: Map<string, DomTreeNode>,
  resultRefs: Set<string>,
  writableNodeIds?: Set<string>
): void {
  if (target.kind === 'node') {
    if (!nodes.has(target.nodeId)) throw new PolicyError(`目标 ${target.nodeId} 不在当前可编辑局部 DOM 内`);
    if (writableNodeIds && !writableNodeIds.has(target.nodeId)) throw new PolicyError(`目标 ${target.nodeId} 仅允许读取或作为插入锚点`);
    return;
  }
  if (!resultRefs.has(target.resultRef)) throw new PolicyError(`计划内引用 ${target.resultRef} 尚未产生`);
}

function validateOperation(
  operation: UIChangeOperation,
  context: SelectedContext,
  nodes: Map<string, DomTreeNode>,
  resultRefs: Set<string>,
  directWritableNodeIds: Set<string>,
  contentWritableNodeIds: Set<string>,
  layoutWritableNodeIds: Set<string>
): void {
  if (operation.type === 'cloneSubtree') {
    validateTarget(operation.source, nodes, resultRefs);
    validateTarget(operation.anchor, nodes, resultRefs);
  } else if (operation.type === 'addComponent') {
    validateTarget(operation.anchor, nodes, resultRefs);
  } else if (operation.type === 'moveElement') {
    validateTarget(operation.target, nodes, resultRefs, directWritableNodeIds);
    validateTarget(operation.anchor, nodes, resultRefs);
  } else if (operation.type === 'updateStyle') {
    const onlyLayout = Object.keys(operation.styles).every(property => LAYOUT_STYLES.has(property));
    validateTarget(operation.target, nodes, resultRefs, onlyLayout ? layoutWritableNodeIds : contentWritableNodeIds);
  } else if (operation.type === 'updateContent' || operation.type === 'setVisualState') {
    validateTarget(operation.target, nodes, resultRefs, contentWritableNodeIds);
  } else {
    validateTarget(operation.target, nodes, resultRefs, directWritableNodeIds);
  }

  if (operation.type === 'cloneSubtree' && operation.source.kind === 'node') {
    const source = nodes.get(operation.source.nodeId)!;
    if (FORBIDDEN_CLONE_TAGS.has(source.tag)) throw new PolicyError(`不允许复制 ${source.tag} 节点`);
  }
  if (operation.type === 'updateStyle') {
    for (const [property, value] of Object.entries(operation.styles)) {
      if (!ALLOWED_STYLES.has(property)) throw new PolicyError(`样式属性 ${property} 不在白名单内`);
      if (/url\s*\(|expression\s*\(/i.test(value)) throw new PolicyError(`样式值 ${value} 不安全`);
    }
  }
  if (operation.type === 'addComponent' && operation.props.href) {
    const url = new URL(operation.props.href, context.page.url);
    if (!SAFE_LINK_PROTOCOLS.has(url.protocol)) throw new PolicyError(`链接协议 ${url.protocol} 不允许`);
  }

  const resultRef = operation.type === 'cloneSubtree' ? operation.resultRef
    : operation.type === 'addComponent' ? operation.resultRef
      : undefined;
  if (resultRef) {
    if (resultRefs.has(resultRef)) throw new PolicyError(`计划内引用 ${resultRef} 重复`);
    resultRefs.add(resultRef);
  }
}

export function validatePlan(plan: ChangePlan, context: SelectedContext): void {
  if (plan.selectionVersion !== context.selectionVersion || plan.pageRevision !== context.pageRevision) {
    throw new PolicyError('页面或选区已变化，请重新生成方案');
  }
  const nodes = indexTrees([context.selectedTree, ...context.reusableTrees, ...context.addedTrees]);
  for (const fact of context.elementFacts ?? []) {
    if (!nodes.has(fact.id)) {
      nodes.set(fact.id, {
        id: fact.id,
        tag: fact.tag ?? 'div',
        text: fact.text ?? '',
        attributes: fact.semanticRole ? { 'data-ui-component': fact.semanticRole } : {},
        children: []
      });
    }
  }
  const addedNodes = indexTrees(context.addedTrees);
  const selectedNodes = indexTrees([context.selectedTree]);
  const directWritableNodeIds = new Set([context.selected.id, ...addedNodes.keys()]);
  const contentWritableNodeIds = new Set(directWritableNodeIds);
  const layoutWritableNodeIds = new Set([
    ...selectedNodes.keys(),
    ...addedNodes.keys(),
    ...(context.elementFacts ?? []).map(fact => fact.id)
  ]);
  if (isInteractiveSelection(context)) {
    const selectedNode = findTreeNode(context.selectedTree, context.selected.id);
    if (selectedNode) indexTrees([selectedNode]).forEach((_node, id) => contentWritableNodeIds.add(id));
  }
  const resultRefs = new Set<string>();
  for (const operation of plan.operations) {
    validateOperation(operation, context, nodes, resultRefs, directWritableNodeIds, contentWritableNodeIds, layoutWritableNodeIds);
  }

  const removesExisting = plan.operations.some(
    operation => operation.type === 'removeElement' && operation.target.kind === 'node'
  );
  if (removesExisting && !plan.requiresConfirmation) {
    throw new PolicyError('删除已有元素的方案必须要求用户确认');
  }
}
