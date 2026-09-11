export const CONTROLLED_INTERACTION_INSTRUCTIONS = [
  '基础控件优先使用浏览器原生 HTML；原生能力不能满足且确有需求时再使用以下声明式交互。无需搜索源码确认这些能力，禁止 script 和 onclick；无法满足的其他交互应调用 clarify。',
  '简单单选下拉优先使用 select + option，浏览器自动处理展开、键盘选择和选中值显示；option 用 value 表示值，用 selected 声明默认选项。不要为普通单选下拉重新拼装浮层、Radio 列表或选中标签同步逻辑，也不要复制缺少 React 运行逻辑的组件 DOM 来冒充可操作 Select。原生弹出选项的外观由浏览器决定，不保证完全复现 Ant Design 浮层。',
  '文本输入使用 input 或 textarea；独立勾选使用 input type="checkbox"；同组单选使用 input type="radio" 并设置同组唯一 name、不同 value。默认值使用 value/checked，textarea 默认文字写在标签内。使用 label 关联控件或提供 aria-label。按钮使用 button type="button"，不得提交真实表单。原生输入、勾选和选择无需 data-ui-agent-action；不要在它们或包裹它们的可点击容器上重复添加 toggle-checkbox/set-radio/toggle 等动作来拦截原生行为。',
  '仅需本地选择状态时保留原生行为；选择后联动其他区域、按钮后续动作及刷新后的状态保存不是自动具备的能力。只实现用户已明确且现有协议支持的演示行为，不能把真实文件上传、搜索或关联业务接口描述为已完成；关键行为不明确时先 clarify。',
  '样式与交互分开处理：原生控件的尺寸、字体、边框和颜色参考当前页面已读取的样式及可识别的组件规范，视觉修改写入当前工作区允许的样式文件。不要把仅适用于 div/span 模拟控件的 wrapper/selector/inner class 直接套到原生控件上；不得为模仿组件库外观引入 React、外部脚本或新的依赖。布局仍由页面结构和用户意图决定，不按控件类型预设位置。',
  '以下规则仅用于确需自定义交互的控件，不是原生表单控件的必填属性。显示、隐藏或浮层使用 data-ui-agent-action="toggle|show|hide" 与 data-ui-agent-targets="source-id"；初始隐藏只能使用 HTML hidden 属性，受控目标不得保留会强制 display:none 的 hidden class。浮层可在触发器设置 data-ui-agent-dismiss="outside escape"。',
  'Tab 使用 set-state + state-group/state-value，面板使用同组 state-when；Checkbox 使用 toggle-checkbox + aria-checked；Radio 组中的每一个可点击选项自身都必须同时声明 data-ui-agent-action="set-radio"、相同的 data-ui-agent-state-group 和各自的 data-ui-agent-state-value，不能只把 state-group/state-value 放在共同父容器上。group/value 只允许英文字母、数字、下划线和连字符。激活样式可用 data-ui-agent-active-class。',
  'Radio 选项最小示例：<button data-ui-agent-action="set-radio" data-ui-agent-state-group="add-source" data-ui-agent-state-value="local">本地文档</button>。同组其他选项保持 state-group="add-source"，只更换各自的 state-value。',
  '新增浮层时，先插入浮层和选项并获取系统生成的真实 sourceId，再给触发器设置 toggle/targets/dismiss；选项点击后要收起浮层时，在每个选项自身设置 data-ui-agent-close-targets="浮层-sourceId"。',
  '控件激活后需要关闭下拉框或其他浮层时，设置 data-ui-agent-close-targets="浮层-source-id"；它与 data-ui-agent-targets 的“显示目标”语义不同，不要用 targets 表示关闭。',
  '交互属性只能引用当前源码中的真实 sourceId。finish 会检查引用、结构和安全规则。'
].join('\n');
