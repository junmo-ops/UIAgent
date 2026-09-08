export const CONTROLLED_INTERACTION_INSTRUCTIONS = [
  '运行时能力已明确：支持以下声明式交互，无需搜索页面源码猜测运行时是否支持。没有列出的能力不能假定存在；无法满足的明确需求必须在提交前说明并澄清，不得自行省略。',
  '浮层关闭：在 toggle/show 触发器上设置 data-ui-agent-dismiss="outside escape"，即可点击触发器和目标浮层之外关闭、按 Escape 关闭最近打开的浮层并返回触发器焦点。可只写 outside 或 escape。点击浮层内输入框不会关闭，外部点击仍正常传递。不需要创建全屏透明遮罩；定位、尺寸由当前页面布局决定。',
  '仅当用户明确要求点击交互时，使用插件固定运行时支持的声明式属性；禁止添加 script 或 onclick。',
  '显示、隐藏、展开、收起：在触发元素写 data-ui-agent-action="toggle|show|hide"，并用 data-ui-agent-targets="source-20 source-21" 指向一个或多个稳定 data-ui-source-id。初始隐藏状态使用 hidden 属性，触发元素同步设置合理的 aria-expanded。',
  'Tab 或互斥状态：触发元素写 data-ui-agent-action="set-state"、data-ui-agent-state-group="安全组名"、data-ui-agent-state-value="状态值"；展示面板写相同 group 和 data-ui-agent-state-when="状态值"。非默认面板使用 hidden。',
  '状态触发元素可用 data-ui-agent-active-class="已有或新增的单个 class"声明激活样式；固定运行时会同步 aria-selected、aria-pressed 和 data-ui-agent-state-active。',
  'Checkbox：使用 data-ui-agent-action="toggle-checkbox"，初始状态用 aria-checked="true|false"；可选 data-ui-agent-targets 联动显示/隐藏目标，不要只写 role="checkbox"。',
  'Radio：使用 data-ui-agent-action="set-radio"、data-ui-agent-state-group 和 data-ui-agent-state-value；同组控件互斥，并同步 aria-checked、aria-selected 与激活样式。下拉展开/收起复用 toggle；选项互斥选择复用 set-radio。',
  '交互属性只允许引用当前源码内真实存在的 sourceId，不允许 CSS selector、URL、代码表达式或任意命令。修改后必须调用 validate_workspace。'
].join('\n');
