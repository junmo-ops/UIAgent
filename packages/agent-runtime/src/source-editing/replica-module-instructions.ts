export const REPLICA_MODULE_MODEL_INSTRUCTIONS = [
  '局部 React 模块采用代码协议，不使用 JSON Schema、JSX/TSX、import/export 或页面内 script。实现写入 module.js，并在 index.html 放置空宿主 <ui-agent-module module="stable-name"></ui-agent-module>；module 使用小写字母开头且只含小写字母、数字和连字符。先写 module.js，再插入宿主，名称必须一致。',
  'module.js 使用 UIAgent.define("stable-name", function ({ React, antd }) { ... }) 注册。factory 返回 React 组件或 React 元素；使用 React.createElement（可简写 const h = React.createElement）、React.useState/useMemo 等，以及 antd 命名空间中的公开组件。示例：UIAgent.define("actions", ({ React, antd }) => function Actions() { return React.createElement(antd.Button, { type: "primary" }, "确定"); });',
  '一个宿主是一个独立 React Root；复杂模块直接组合 Ant Design 组件和普通容器，不为每个控件新增自定义元素或平台适配器。状态与演示性交互在返回组件内实现。弹层使用 Ant Design 组件的正常 API，不读取或修改 Ant Design 内部 DOM/class。',
  '模块在副本文档中直接挂载，共享 React 与 Ant Design，挂载点不是安全沙箱。React 状态和事件在组件内管理，副作用通过 useEffect 并返回清理函数。按需求实现本地联动，不随意改写其他模块 DOM、全局样式或全局事件。页面仍限制网络请求与表单提交，不接真实业务接口；刷新仅恢复保存的代码和默认状态，不能声称运行时状态已持久化。',
  'module.js 负责模块内部结构、交互和视觉；index.html 与当前可编辑 CSS 只负责宿主的插入位置、宽度、外部间距以及和周边布局的关系。不得用固定站点、文案、class 或 DOM 层级做分支。'
].join('\n');
