import { COMPONENT_SELECTION_INSTRUCTIONS } from './component-selection-instructions';
import { REPLICA_MODULE_MODEL_INSTRUCTIONS } from './replica-module-instructions';

export const INTERACTION_INSTRUCTIONS = [
  COMPONENT_SELECTION_INSTRUCTIONS,
  '普通 HTML 禁止 script 和 onclick。新建模块所需的本地状态与演示性交互写在受控的 module.jsx 中。',
  REPLICA_MODULE_MODEL_INSTRUCTIONS,
  '保留既有原生控件或明确原样复制时，input 默认值使用 value，checkbox/radio 使用 checked，textarea 默认文字写在标签内。使用 label 关联控件或提供 aria-label。按钮使用 button type="button"，不得提交真实表单。',
  '新增或重做交互统一在 module.jsx 中使用 React 状态和事件实现。仅需本地选择状态时可保留既有原生行为；选择后的联动、按钮动作及刷新后的状态保存不是自动具备的能力。不能把真实文件上传、搜索或关联业务接口描述为已完成；关键行为不明确时先 clarify。',
  '保留既有原生控件的小改仍参考当前页面实际样式。ui-agent-module 内部内容应通过 module.jsx 修改，不直接改写 React 管理的 DOM。',
].join('\n');
