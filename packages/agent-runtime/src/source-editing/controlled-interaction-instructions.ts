export const CONTROLLED_INTERACTION_INSTRUCTIONS = [
  '声明式交互运行时已支持下列能力，无需搜索源码确认；无法满足的其他交互应调用 clarify。禁止 script 和 onclick。',
  '显示、隐藏或浮层使用 data-ui-agent-action="toggle|show|hide" 与 data-ui-agent-targets="source-id"；初始隐藏只能使用 HTML hidden 属性，受控目标不得保留会强制 display:none 的 hidden class。浮层可在触发器设置 data-ui-agent-dismiss="outside escape"。',
  'Tab 使用 set-state + state-group/state-value，面板使用同组 state-when；Checkbox 使用 toggle-checkbox + aria-checked；Radio 组中的每一个可点击选项自身都必须同时声明 data-ui-agent-action="set-radio"、相同的 data-ui-agent-state-group 和各自的 data-ui-agent-state-value，不能只把 state-group/state-value 放在共同父容器上。group/value 只允许英文字母、数字、下划线和连字符。激活样式可用 data-ui-agent-active-class。',
  'Radio 选项最小示例：<button data-ui-agent-action="set-radio" data-ui-agent-state-group="add-source" data-ui-agent-state-value="local">本地文档</button>。同组其他选项保持 state-group="add-source"，只更换各自的 state-value。',
  '新增浮层时，先插入浮层和选项并获取系统生成的真实 sourceId，再给触发器设置 toggle/targets/dismiss；选项点击后要收起浮层时，在每个选项自身设置 data-ui-agent-close-targets="浮层-sourceId"。',
  '控件激活后需要关闭下拉框或其他浮层时，设置 data-ui-agent-close-targets="浮层-source-id"；它与 data-ui-agent-targets 的“显示目标”语义不同，不要用 targets 表示关闭。',
  '交互属性只能引用当前源码中的真实 sourceId。finish 会检查引用、结构和安全规则。'
].join('\n');
