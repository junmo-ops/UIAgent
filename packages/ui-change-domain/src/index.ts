import type { ChangePlan, DomTreeNode, NodeTarget, SelectedContext, UIChangeOperation } from '@ui-agent/contracts';

const ALLOWED_STYLES = new Set([
  'color', 'backgroundColor', 'fontSize', 'fontWeight', 'width', 'height',
  'margin', 'marginLeft', 'marginRight', 'marginTop', 'marginBottom',
  'padding', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
  'border', 'borderColor', 'borderRadius', 'display', 'gap', 'opacity'
]);

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const FORBIDDEN_CLONE_TAGS = new Set(['html', 'body', 'script', 'style', 'iframe', 'object', 'embed']);

export class PolicyError extends Error {
  readonly code = 'POLICY_ERROR';
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
  writableNodeIds: Set<string>
): void {
  if (operation.type === 'cloneSubtree') {
    validateTarget(operation.source, nodes, resultRefs);
    validateTarget(operation.anchor, nodes, resultRefs);
  } else if (operation.type === 'addComponent') {
    validateTarget(operation.anchor, nodes, resultRefs);
  } else if (operation.type === 'moveElement') {
    validateTarget(operation.target, nodes, resultRefs, writableNodeIds);
    validateTarget(operation.anchor, nodes, resultRefs);
  } else {
    validateTarget(operation.target, nodes, resultRefs, writableNodeIds);
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
  const addedNodes = indexTrees(context.addedTrees);
  const writableNodeIds = new Set([context.selected.id, ...addedNodes.keys()]);
  const resultRefs = new Set<string>();
  for (const operation of plan.operations) validateOperation(operation, context, nodes, resultRefs, writableNodeIds);

  const removesExisting = plan.operations.some(
    operation => operation.type === 'removeElement' && operation.target.kind === 'node'
  );
  if (removesExisting && !plan.requiresConfirmation) {
    throw new PolicyError('删除已有元素的方案必须要求用户确认');
  }
}
