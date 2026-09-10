export const CONTROLLED_INTERACTION_INSTRUCTIONS = [
  '声明式交互运行时已支持下列能力，无需搜索源码确认；无法满足的其他交互应调用 clarify。禁止 script 和 onclick。',
  '显示、隐藏或浮层使用 data-ui-agent-action="toggle|show|hide" 与 data-ui-agent-targets="source-id"；初始隐藏只能使用 HTML hidden 属性，受控目标不得保留会强制 display:none 的 hidden class。浮层可在触发器设置 data-ui-agent-dismiss="outside escape"。',
  'Tab 使用 set-state + state-group/state-value，面板使用同组 state-when；Checkbox 使用 toggle-checkbox + aria-checked；Radio 使用 set-radio + state-group/state-value。激活样式可用 data-ui-agent-active-class。',
  '控件激活后需要关闭下拉框或其他浮层时，设置 data-ui-agent-close-targets="浮层-source-id"；它与 data-ui-agent-targets 的“显示目标”语义不同，不要用 targets 表示关闭。',
  '交互属性只能引用当前源码中的真实 sourceId。finish 会检查引用、结构和安全规则。'
].join('\n');
