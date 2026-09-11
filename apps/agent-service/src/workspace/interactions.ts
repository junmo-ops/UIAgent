import { parseHTML } from 'linkedom';

const ACTION_ATTRIBUTE = 'data-ui-agent-action';
const TARGETS_ATTRIBUTE = 'data-ui-agent-targets';
const CLOSE_TARGETS_ATTRIBUTE = 'data-ui-agent-close-targets';
const GROUP_ATTRIBUTE = 'data-ui-agent-state-group';
const VALUE_ATTRIBUTE = 'data-ui-agent-state-value';
const WHEN_ATTRIBUTE = 'data-ui-agent-state-when';
const ACTIVE_CLASS_ATTRIBUTE = 'data-ui-agent-active-class';
const ACTIONS = new Set(['toggle', 'show', 'hide', 'set-state', 'toggle-checkbox', 'set-radio']);

function elementDescription(element: Element): string {
  const sourceId = element.getAttribute('data-ui-source-id');
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return [sourceId ?? `<${element.tagName.toLowerCase()}>`, text ? `“${text}”` : undefined]
    .filter(Boolean)
    .join(' ');
}

function safeTokens(
  element: Element,
  attribute: string,
  issues: string[],
  max = 20,
  guidance?: string
): string[] {
  const value = element.getAttribute(attribute);
  const values = (value ?? '').trim().split(/\s+/).filter(Boolean);
  if (values.length && values.length <= max && values.every(item => (
    item.length <= 120 && /^[a-zA-Z0-9_-]+$/.test(item)
  ))) return values;
  const actual = value === null ? '缺失' : `当前值 ${JSON.stringify(value)}`;
  issues.push(
    `${elementDescription(element)} 的 ${attribute} ${actual}；必须在该元素自身设置 1-${max} 个仅含英文字母、数字、下划线或连字符的标识符${guidance ? `；${guidance}` : ''}`
  );
  return [];
}

function throwInteractionIssues(issues: string[]): void {
  if (!issues.length) return;
  const uniqueIssues = [...new Set(issues)];
  throw new Error(
    `受控交互校验发现 ${uniqueIssues.length} 个问题：\n${uniqueIssues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}`
  );
}

function hasAction(element: Element): boolean {
  return element.hasAttribute(ACTION_ATTRIBUTE);
}

function invalidActionMessage(element: Element, action: string): string {
  return `${elementDescription(element)} 不支持的受控交互动作：${JSON.stringify(action || '')}；${ACTION_ATTRIBUTE} 可用值为 ${[...ACTIONS].join(', ')}`;
}

function invalidDismissMessage(element: Element): string {
  return `${elementDescription(element)} 的 data-ui-agent-dismiss 只能在 toggle/show 触发器上使用 outside、escape`;
}

function invalidCheckboxStateMessage(element: Element): string {
  return `${elementDescription(element)} 是 toggle-checkbox，不应声明 ${GROUP_ATTRIBUTE} 或 ${VALUE_ATTRIBUTE}`;
}

function missingStatePanelMessage(element: Element, group: string, value: string): string {
  return `${elementDescription(element)} 的状态 ${group}/${value} 没有对应的展示面板；面板需在自身设置 ${GROUP_ATTRIBUTE}="${group}" 和包含 ${value} 的 ${WHEN_ATTRIBUTE}`;
}

function hiddenTargetMessage(control: Element, targetSourceId: string): string {
  return `${elementDescription(control)} 的受控目标 ${targetSourceId} 使用了 hidden class；请移除该 class，并用 HTML hidden 属性声明初始隐藏`;
}

function missingTargetMessage(control: Element, targetSourceId: string, closeOnly: boolean): string {
  return `${elementDescription(control)} 引用的${closeOnly ? '关闭' : '显示'}目标 ${targetSourceId} 不存在（当前源码未找到该 sourceId）`;
}

function closeTargetsWithoutActionMessage(element: Element): string {
  return `${elementDescription(element)} 声明了 ${CLOSE_TARGETS_ATTRIBUTE}，但缺少 ${ACTION_ATTRIBUTE}`;
}

function radioAttributeGuidance(attribute: string): string {
  return `每个 set-radio 选项都必须在自身声明 ${attribute}，不能只声明在共同父容器上`;
}

function panelHiddenClassMessage(element: Element): string {
  return `${elementDescription(element)} 是状态面板，不得使用 hidden class；请移除该 class，并用 HTML hidden 属性声明初始隐藏`;
}

function actionRequiredForCloseTargets(element: Element, issues: string[]): void {
  if (!hasAction(element)) issues.push(closeTargetsWithoutActionMessage(element));
}

function validateDismiss(element: Element, issues: string[]): void {
  const modes = safeTokens(element, 'data-ui-agent-dismiss', issues, 2);
  if (modes.length && (
    modes.some(mode => mode !== 'outside' && mode !== 'escape')
    || !['toggle', 'show'].includes(element.getAttribute(ACTION_ATTRIBUTE) ?? '')
  )) issues.push(invalidDismissMessage(element));
}

function sourceIdsInDocument(document: Document): Set<string> {
  return new Set(
    [...document.querySelectorAll('[data-ui-source-id]')]
      .map(element => element.getAttribute('data-ui-source-id'))
      .filter((value): value is string => Boolean(value))
  );
}

function validateTargets(
  document: Document,
  sourceIds: Set<string>,
  control: Element,
  attribute: string,
  issues: string[],
  closeOnly = false
): void {
  if (!control.hasAttribute(attribute)) return;
  for (const sourceId of safeTokens(control, attribute, issues)) {
    if (!sourceIds.has(sourceId)) {
      issues.push(missingTargetMessage(control, sourceId, closeOnly));
      continue;
    }
    if (!closeOnly) {
      const target = document.querySelector(`[data-ui-source-id="${sourceId}"]`);
      if (target?.classList.contains('hidden')) issues.push(hiddenTargetMessage(control, sourceId));
    }
  }
}

function validateRadio(control: Element, document: Document, sourceIds: Set<string>, issues: string[]): void {
  safeTokens(control, GROUP_ATTRIBUTE, issues, 1, radioAttributeGuidance(GROUP_ATTRIBUTE));
  safeTokens(control, VALUE_ATTRIBUTE, issues, 1, radioAttributeGuidance(VALUE_ATTRIBUTE));
  validateTargets(document, sourceIds, control, TARGETS_ATTRIBUTE, issues);
}

function validateStateControl(control: Element, document: Document, issues: string[]): void {
  const group = safeTokens(control, GROUP_ATTRIBUTE, issues, 1)[0];
  const value = safeTokens(control, VALUE_ATTRIBUTE, issues, 1)[0];
  if (!group || !value) return;
  const hasPanel = [...document.querySelectorAll(`[${GROUP_ATTRIBUTE}][${WHEN_ATTRIBUTE}]`)]
    .some(panel => panel.getAttribute(GROUP_ATTRIBUTE) === group
      && safeTokens(panel, WHEN_ATTRIBUTE, issues).includes(value));
  if (!hasPanel) issues.push(missingStatePanelMessage(control, group, value));
}

function validateStatePanel(panel: Element, issues: string[]): void {
  safeTokens(panel, GROUP_ATTRIBUTE, issues, 1);
  safeTokens(panel, WHEN_ATTRIBUTE, issues);
  if (panel.classList.contains('hidden')) issues.push(panelHiddenClassMessage(panel));
}

function validateControl(document: Document, sourceIds: Set<string>, control: Element, issues: string[]): void {
  const action = control.getAttribute(ACTION_ATTRIBUTE) ?? '';
  if (!ACTIONS.has(action)) {
    issues.push(invalidActionMessage(control, action));
    return;
  }
  if (control.hasAttribute(ACTIVE_CLASS_ATTRIBUTE)) {
    safeTokens(control, ACTIVE_CLASS_ATTRIBUTE, issues, 1);
  }
  validateTargets(document, sourceIds, control, CLOSE_TARGETS_ATTRIBUTE, issues, true);
  if (action === 'toggle-checkbox') {
    if (control.hasAttribute(GROUP_ATTRIBUTE) || control.hasAttribute(VALUE_ATTRIBUTE)) {
      issues.push(invalidCheckboxStateMessage(control));
    }
    validateTargets(document, sourceIds, control, TARGETS_ATTRIBUTE, issues);
    return;
  }
  if (action === 'set-radio') {
    validateRadio(control, document, sourceIds, issues);
    return;
  }
  if (action === 'set-state') {
    validateStateControl(control, document, issues);
    return;
  }
  validateTargets(document, sourceIds, control, TARGETS_ATTRIBUTE, issues);
}

export function validateControlledInteractions(html: string): void {
  const { document } = parseHTML(html);
  const issues: string[] = [];
  for (const control of document.querySelectorAll(`[${CLOSE_TARGETS_ATTRIBUTE}]`)) {
    actionRequiredForCloseTargets(control, issues);
  }
  for (const control of document.querySelectorAll('[data-ui-agent-dismiss]')) {
    validateDismiss(control, issues);
  }
  const sourceIds = sourceIdsInDocument(document);
  for (const control of document.querySelectorAll(`[${ACTION_ATTRIBUTE}]`)) {
    validateControl(document, sourceIds, control, issues);
  }
  for (const panel of document.querySelectorAll(`[${WHEN_ATTRIBUTE}]`)) {
    validateStatePanel(panel, issues);
  }
  throwInteractionIssues(issues);
}
