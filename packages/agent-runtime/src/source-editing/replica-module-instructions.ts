export const REPLICA_MODULE_MODEL_INSTRUCTIONS = [
  '局部模块固定提供 React 19.2.7、Ant Design 6.5.1，使用其公开 API；原站框架、class 或外观不代表平台版本，不添加假想旧版兼容。',
  '当前版本已确认支持 Form component={false}（不生成 form 标签）、Form.Item 的 htmlFor/required/validateStatus/help，以及 Space.Compact。validateStatus 可为 success/error/warning/validating/空字符串；Input.status 同样支持这些状态。不因猜测版本移除这些 API 而重新设计；现有受控状态与公开 props 已满足需求时直接复用，不推演库内部实现。',
  'Form component={false} 没有原生 form 提交事件，htmlType="submit" 不会自动触发 onFinish。需要提交时用真实 Form/form，或让按钮明确调用 form.submit()/本地处理函数；确认所声明的校验和结果提示有实际触发入口。',
  'Ant Design Button 的 type 是外观（default/primary/dashed/link/text），原生行为用 htmlType="button" 或 "submit"；不能写 type="button"。保留已有合法 props；发现无效 API 直接按当前公开接口修正，不假设用户已验收错误实现，也不反复比较是否保留错误属性。',
  '实现写入 module.jsx：纯 JSX，不用 JSON Schema、TSX、import/export 或 script。module.js 是编译产物，禁止读写。先写模块，再用 insert_element 按已规划的容器与源码位置插入空宿主 <ui-agent-module module="stable-name"></ui-agent-module>；替换现有控件用 replace_element。不要为挂载宿主拼接祖先整段 HTML 或猜测文件字符位置。名称相同，以小写字母开头，仅含小写字母/数字/连字符。',
  '注册示例：UIAgent.define("actions", ({ React, antd }) => { const { Button } = antd; return function Actions() { return <Button type="primary">确定</Button>; }; }); factory 返回 React 组件或元素；状态/hooks 放在返回组件内，可使用 antd 公开组件。每个宿主是独立 React Root，复杂模块组合组件与普通容器，无需逐控件创建宿主或平台适配器。',
  'factory 提供 React、antd 和 ui，没有 antd.icons，也不提供 @ant-design/icons 导入。图标可直接使用内联 SVG 元素，再传给公开 icon/prefix 等属性；不能从不存在的图标命名空间解构组件。',
  '输入、选择、多行文本控件必须具有与可见标签一致的可访问名称，placeholder/title/邻近文字不能替代关联。Form.Item 只有 label 不保证关联，尤其无 name 或自定义 id 时。用 React.useId() 为每实例生成唯一 id，label/Form.Item 的 htmlFor 与控件 id 相同；也可正确使用 Form/name 或 aria-labelledby。改标签同步命名关系，不遗留旧 aria-label。',
  '仅在本轮要求自定义校验提示时，由 Form/rules 或组件状态处理所需校验，在实际 form 上设置 noValidate，避免原生校验先拦截提交、气泡覆盖提示。保留输入语义并清除过期提示；不为仅展示的控件主动添加校验或结果反馈。用户明确要求原生校验时遵从其要求。',
  'Dropdown 菜单用 menu={{ items, ... }}，自定义弹层用 popupRender={() => <单个根元素>...</单个根元素>}，禁用已移除的 overlay。触发子节点须是单个能接收事件与 ref 的 React 元素（如 Button）；弹层返回有效元素，不能 undefined/数组。编译成功不等于组件 API 和点击行为正确。',
  '受控弹层只用一个开关状态入口：配置 trigger 时由 onOpenChange 更新 open，触发子节点不要再反转同一 open 状态；自行处理触发事件时不要同时启用组件的自动触发。否则一次点击可能打开后立即关闭。',
  '新建锚点弹层优先复用 ui.AnchoredPanel，而非重复编写测量、避让与关闭代码。API：<ui.AnchoredPanel anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} width={520} placement="bottom" align="start" label="面板名称">...</ui.AnchoredPanel>。anchorRef=React.useRef(null) 绑定在实际触发按钮；按钮 onClick 切换 open，组件没有自动触发开关。它提供真实锚点/视口测量、整面板限宽限高、上下避让、页面滚动/尺寸变化更新、外部点击/Escape 关闭和顶层浮层；无需再叠加 Popover 或手动定位。children 直接排列在内置 column flex 面板内；标题/输入/提示使用 flexShrink:0，结果区域使用 flex:"1 1 auto"、minHeight:0、overflowY:"auto"，模型负责需求内容与外观。width/placement/align 按实际需求选择，不照抄示例尺寸。',
  '弹层必须约束整张面板的视口空间，不能只给列表设置固定 maxHeight。若不用 ui.AnchoredPanel，须用实际触发 ref 与视口约束整面板（计入标题、输入、提示和边距），更新测量并清理监听；普通 Popover 自动翻转不能替代总高度约束。capturedViewport 与 capturedRect 只作为规划参考，不能代替渲染验证。',
  '弹层使用组件正常 API，不读写 Ant Design 内部 DOM/class。模块直接挂载于副本文档，不是安全沙箱；用组件状态/事件管理交互，useEffect 返回副作用清理函数，不改其他模块 DOM、全局样式或事件。网络请求和表单提交仍受限，不接真实业务；刷新恢复代码与默认状态，不声称运行态持久化。',
  'module.jsx 管模块内部结构、交互和样式，样式用组件 props 或合法 JSX 表达，不追加裸 CSS 规则；index.html 与可编辑 CSS 只管宿主位置、宽度、外间距及周边布局。不得按站点、文案、class、固定层级分支。编译错误返回源码行列，修正后继续。'
].join('\n');
