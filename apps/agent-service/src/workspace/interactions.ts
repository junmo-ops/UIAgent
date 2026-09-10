import { parseHTML } from 'linkedom';

const ACTION_ATTRIBUTE = 'data-ui-agent-action';
const TARGETS_ATTRIBUTE = 'data-ui-agent-targets';
const CLOSE_TARGETS_ATTRIBUTE = 'data-ui-agent-close-targets';
const GROUP_ATTRIBUTE = 'data-ui-agent-state-group';
const VALUE_ATTRIBUTE = 'data-ui-agent-state-value';
const WHEN_ATTRIBUTE = 'data-ui-agent-state-when';
const ACTIVE_CLASS_ATTRIBUTE = 'data-ui-agent-active-class';
const ACTIONS = new Set(['toggle', 'show', 'hide', 'set-state', 'toggle-checkbox', 'set-radio']);

function tokens(value: string | null, label: string, max = 20): string[] {
  const values = (value ?? '').trim().split(/\s+/).filter(Boolean);
  if (!values.length || values.length > max || values.some(item => item.length > 120 || !/^[a-zA-Z0-9_-]+$/.test(item))) {
    throw new Error(`${label} 必须包含 1-${max} 个安全标识符`);
  }
  return values;
}

export function validateControlledInteractions(html: string): void {
  const { document } = parseHTML(html);
  for (const control of document.querySelectorAll(`[${CLOSE_TARGETS_ATTRIBUTE}]`)) {
    if (!control.hasAttribute(ACTION_ATTRIBUTE)) {
      throw new Error(`${CLOSE_TARGETS_ATTRIBUTE} 只能用于受控交互元素`);
    }
  }
  for (const control of document.querySelectorAll('[data-ui-agent-dismiss]')) {
    const modes = tokens(control.getAttribute('data-ui-agent-dismiss'), 'data-ui-agent-dismiss', 2);
    if (modes.some(mode => mode !== 'outside' && mode !== 'escape') ||
      !['toggle', 'show'].includes(control.getAttribute(ACTION_ATTRIBUTE) ?? '')) {
      throw new Error('data-ui-agent-dismiss 仅支持 toggle/show 触发器上的 outside、escape');
    }
  }
  const sourceIds = new Set(
    [...document.querySelectorAll('[data-ui-source-id]')]
      .map(element => element.getAttribute('data-ui-source-id'))
      .filter((value): value is string => Boolean(value))
  );
  const validateTargets = (control: Element, attribute: string, closeOnly = false) => {
    if (!control.hasAttribute(attribute)) return;
    for (const sourceId of tokens(control.getAttribute(attribute), attribute)) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(`${closeOnly ? '受控交互关闭目标' : '受控交互目标'} ${sourceId} 不存在`);
      }
      if (!closeOnly) {
        const target = document.querySelector(`[data-ui-source-id="${sourceId}"]`);
        if (target?.classList.contains('hidden')) {
          throw new Error(`受控交互目标 ${sourceId} 使用了 hidden class，运行时无法可靠显示；请移除该 class，并用 HTML hidden 属性声明初始隐藏`);
        }
      }
    }
  };
  for (const control of document.querySelectorAll(`[${ACTION_ATTRIBUTE}]`)) {
    const action = control.getAttribute(ACTION_ATTRIBUTE) ?? '';
    if (!ACTIONS.has(action)) throw new Error(`不支持的受控交互动作：${action || '空值'}`);
    const activeClass = control.getAttribute(ACTIVE_CLASS_ATTRIBUTE);
    if (activeClass) tokens(activeClass, ACTIVE_CLASS_ATTRIBUTE, 1);
    validateTargets(control, CLOSE_TARGETS_ATTRIBUTE, true);
    if (action === 'toggle-checkbox') {
      if (control.hasAttribute(GROUP_ATTRIBUTE) || control.hasAttribute(VALUE_ATTRIBUTE)) {
        throw new Error('checkbox 不应声明状态组和值');
      }
      validateTargets(control, TARGETS_ATTRIBUTE);
      continue;
    }
    if (action === 'set-radio') {
      tokens(control.getAttribute(GROUP_ATTRIBUTE), GROUP_ATTRIBUTE, 1);
      tokens(control.getAttribute(VALUE_ATTRIBUTE), VALUE_ATTRIBUTE, 1);
      validateTargets(control, TARGETS_ATTRIBUTE);
      continue;
    }
    if (action === 'set-state') {
      const group = tokens(control.getAttribute(GROUP_ATTRIBUTE), GROUP_ATTRIBUTE, 1)[0]!;
      const value = tokens(control.getAttribute(VALUE_ATTRIBUTE), VALUE_ATTRIBUTE, 1)[0]!;
      const hasPanel = [...document.querySelectorAll(`[${GROUP_ATTRIBUTE}][${WHEN_ATTRIBUTE}]`)]
        .some(panel => panel.getAttribute(GROUP_ATTRIBUTE) === group
          && tokens(panel.getAttribute(WHEN_ATTRIBUTE), WHEN_ATTRIBUTE).includes(value));
      if (!hasPanel) throw new Error(`状态交互 ${group}/${value} 没有对应的展示面板`);
      continue;
    }
    validateTargets(control, TARGETS_ATTRIBUTE);
  }
  for (const panel of document.querySelectorAll(`[${WHEN_ATTRIBUTE}]`)) {
    tokens(panel.getAttribute(GROUP_ATTRIBUTE), GROUP_ATTRIBUTE, 1);
    tokens(panel.getAttribute(WHEN_ATTRIBUTE), WHEN_ATTRIBUTE);
    if (panel.classList.contains('hidden')) {
      throw new Error('状态面板使用了 hidden class，运行时无法可靠显示；请移除该 class，并用 HTML hidden 属性声明初始隐藏');
    }
  }
}
