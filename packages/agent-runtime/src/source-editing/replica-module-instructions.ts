export const REPLICA_MODULE_MODEL_INSTRUCTIONS = [
  '平台局部模块提供 React 19.2.7 与 Ant Design 6.5.1，与原网站使用的框架或组件库版本无关。按平台版本的公开 API 编写，不根据原站 class、外观或历史经验猜测版本，不为假设的旧版本添加兼容写法。',
  '局部 React 模块采用 JSX 代码协议，不使用 JSON Schema、TSX、import/export 或页面内 script。实现写入 module.jsx；module.js 是平台编译产物，禁止读取或修改。在 index.html 放置空宿主 <ui-agent-module module="stable-name"></ui-agent-module>；module 使用小写字母开头且只含小写字母、数字和连字符。先写 module.jsx，再插入宿主，名称必须一致。',
  'module.jsx 使用 UIAgent.define("stable-name", function ({ React, antd }) { ... }) 注册。factory 返回 React 组件或 React 元素；可以直接使用 JSX、React.useState/useMemo 等，以及 antd 命名空间中的公开组件。示例：UIAgent.define("actions", ({ React, antd }) => { const { Button } = antd; return function Actions() { return <Button type="primary">确定</Button>; }; });',
  '一个宿主是一个独立 React Root；复杂模块直接组合 Ant Design 组件和普通容器，不为每个控件新增自定义元素或平台适配器。状态与演示性交互在返回组件内实现。弹层使用 Ant Design 组件的正常 API，不读取或修改 Ant Design 内部 DOM/class。',
  'Dropdown 的菜单使用 menu={{ items, ... }}，自定义弹层内容使用 popupRender={() => <单个根元素>...</单个根元素>}；不要使用已移除的 overlay 属性。Dropdown 的触发子节点必须是单个可接收事件与 ref 的 React 元素，例如 Button；自定义弹层也必须返回一个有效 React 元素，不能返回 undefined 或数组。JSX 编译通过不代表组件 API 或点击后的运行行为已经验证。',
  '模块在副本文档中直接挂载，共享 React 与 Ant Design，挂载点不是安全沙箱。React 状态和事件在组件内管理，副作用通过 useEffect 并返回清理函数。按需求实现本地联动，不随意改写其他模块 DOM、全局样式或全局事件。页面仍限制网络请求与表单提交，不接真实业务接口；刷新仅恢复保存的代码和默认状态，不能声称运行时状态已持久化。',
  'module.jsx 负责模块内部结构、交互和视觉；index.html 与当前可编辑 CSS 只负责宿主的插入位置、宽度、外部间距以及和周边布局的关系。不得用固定站点、文案、class 或 DOM 层级做分支。编译错误会返回 module.jsx 的行列位置，修正源码后再继续。'
].join('\n');
