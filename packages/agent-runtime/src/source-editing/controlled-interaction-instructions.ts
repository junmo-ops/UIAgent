export const CONTROLLED_INTERACTION_INSTRUCTIONS = [
  '仅当用户明确要求点击交互时，使用插件固定运行时支持的声明式属性；禁止添加 script 或 onclick。',
  '显示、隐藏、展开、收起：在触发元素写 data-ui-agent-action="toggle|show|hide"，并用 data-ui-agent-targets="source-20 source-21" 指向一个或多个稳定 data-ui-source-id。初始隐藏状态使用 hidden 属性，触发元素同步设置合理的 aria-expanded。',
  'Tab 或互斥状态：触发元素写 data-ui-agent-action="set-state"、data-ui-agent-state-group="安全组名"、data-ui-agent-state-value="状态值"；展示面板写相同 group 和 data-ui-agent-state-when="状态值"。非默认面板使用 hidden。',
  '状态触发元素可用 data-ui-agent-active-class="已有或新增的单个 class"声明激活样式；固定运行时会同步 aria-selected、aria-pressed 和 data-ui-agent-state-active。',
  '交互属性只允许引用当前源码内真实存在的 sourceId，不允许 CSS selector、URL、代码表达式或任意命令。修改后必须调用 validate_workspace。'
].join('\n');
