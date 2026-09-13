import { COMPONENT_SELECTION_INSTRUCTIONS } from './component-selection-instructions';
import { REPLICA_MODULE_MODEL_INSTRUCTIONS } from './replica-module-instructions';

export const CONTROLLED_INTERACTION_INSTRUCTIONS = [
  COMPONENT_SELECTION_INSTRUCTIONS,
  '普通 HTML 禁止 script 和 onclick。新建模块所需的本地状态与演示性交互写在受控的 module.js 中。',
  REPLICA_MODULE_MODEL_INSTRUCTIONS,
  '以下原生控件规则适用于修改既有内容以及按用户要求复制、复用风格的 HTML 实现；不得用于绕过默认新建的 Ant Design 选型：input 的默认值使用 value，checkbox/radio 使用 checked，textarea 默认文字写在标签内。使用 label 关联控件或提供 aria-label。按钮使用 button type="button"，不得提交真实表单。原生输入、勾选和选择无需 data-ui-agent-action；不要重复绑定动作拦截其原生行为。',
  '仅需本地选择状态时保留原生行为；选择后联动其他区域、按钮后续动作及刷新后的状态保存不是自动具备的能力。只实现用户已明确且现有协议支持的演示行为，不能把真实文件上传、搜索或关联业务接口描述为已完成；关键行为不明确时先 clarify。',
  '其他原生控件仍参考当前页面实际样式。ui-agent-module 内部内容应通过 module.js 修改，不直接改写 React 管理的 DOM。',
  '以下受控交互规则用于既有内容及明确复制或风格复用的 HTML 实现，不代表 module.js 内部交互。显示、隐藏或浮层使用 data-ui-agent-action="toggle|show|hide" 与 data-ui-agent-targets="source-id"；初始隐藏只能使用 HTML hidden 属性，受控目标不得保留会强制 display:none 的 hidden class。浮层可在触发器设置 data-ui-agent-dismiss="outside escape"。',
  'Tab 使用 set-state + state-group/state-value，面板使用同组 state-when；Checkbox 使用 toggle-checkbox + aria-checked；Radio 组中的每一个可点击选项自身都必须同时声明 data-ui-agent-action="set-radio"、相同的 data-ui-agent-state-group 和各自的 data-ui-agent-state-value，不能只把 state-group/state-value 放在共同父容器上。group/value 只允许英文字母、数字、下划线和连字符。激活样式可用 data-ui-agent-active-class。',
  'Radio 选项最小示例：<button data-ui-agent-action="set-radio" data-ui-agent-state-group="add-source" data-ui-agent-state-value="local">本地文档</button>。同组其他选项保持 state-group="add-source"，只更换各自的 state-value。',
  '新增浮层时，先插入浮层和选项并获取系统生成的真实 sourceId，再给触发器设置 toggle/targets/dismiss；选项点击后要收起浮层时，在每个选项自身设置 data-ui-agent-close-targets="浮层-sourceId"。',
  '控件激活后需要关闭下拉框或其他浮层时，设置 data-ui-agent-close-targets="浮层-source-id"；它与 data-ui-agent-targets 的“显示目标”语义不同，不要用 targets 表示关闭。',
  '交互属性只能引用当前源码中的真实 sourceId。finish 会检查引用、结构和安全规则。'
].join('\n');
