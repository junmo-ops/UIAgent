# UIAgent · UI 需求示意助手

面向产品经理的 Chrome 插件：将当前网页创建为可编辑副本，通过自然语言调整 UI，制作可交互的需求示意。

使用流程：**打开原页面 → 进入副本编辑 → 选中区域并描述需求 → 多轮调整 → 导出截图**。

## 能做什么

- 修改页面文案、结构、布局和样式，保留原网站作为参考。
- 新增 React / Ant Design 模块，支持筛选、显隐、表单等本地演示交互；明确要求复制或沿用页面风格时按实际上下文处理。
- 支持需求澄清、普通问答、多轮编辑、撤销/重做和截图导出。
- 管理历史副本，保存源码版本和对话；提供模型与工具调用日志。

副本用于需求示意，不连接原网站业务接口。原页面脚本不会直接复用，复杂动态内容不保证完整还原；刷新可恢复已保存的代码，但不会保留组件运行时的临时状态。

## 本地启动

准备 Node.js 22 或更高版本、**pnpm 10.33.0**（以 `package.json` 为准）和支持 Side Panel 的 Chrome。

```bash
pnpm install --frozen-lockfile
```

将 `apps/agent-service/.env.example` 复制为同目录下的 `.env`，填写 `MODEL_API_KEY`。模型地址和名称也在此配置，凭证不要提交到仓库。

```bash
# 同时启动 Agent Service 和插件开发构建
pnpm dev
```

也可在两个终端分别运行 `pnpm dev:service` 和 `pnpm dev:extension`。

1. 打开 `chrome://extensions`，开启开发者模式，加载 `apps/extension/.output/chrome-mv3`。
2. 在普通 HTTP/HTTPS 网页点击插件图标，选择“进入副本编辑”。
3. 在新打开的副本中点击“选择”，选中区域并输入需求。

默认服务地址为 `http://127.0.0.1:8787`；健康检查为 `/health`，调试日志页为 `/logs`。浏览器内部页面和 Chrome Web Store 等受保护页面不支持捕获。

## 工作原理

插件捕获页面，Agent Service 保存副本并运行 Cline SDK Agent。模型通过受控工具读取上下文、澄清需求和修改源码。

| 文件 | 职责 |
| --- | --- |
| `index.html` | 页面结构、文案和 React 模块挂载位置 |
| `author-overrides.css` | 默认作者样式模式下的样式调整 |
| `module.jsx` | 模型编写的局部 React 模块与交互 |
| `module.js` | 服务通过 esbuild 自动生成的浏览器执行产物，模型不直接编辑 |

React 模块直接挂载在副本文档中，共享 React 和 Ant Design。编译在现有 Agent Service 内完成，无需新增服务；模块源码统一使用 `module.jsx`，导入时重新生成执行产物。

当前默认使用作者 CSS 创建副本；冻结计算样式的 A 方案仅用于诊断。真实浏览器候选验证仍是默认关闭的实验能力，静态校验通过不代表视觉和交互效果已经验证。配置入口见 `apps/agent-service/.env.example`。

## 部署与交付

内网用户只需安装指向已部署服务的插件。副本和历史记录保存在服务端；安装身份可提供 Chrome Profile 级隔离，不等同于员工账号登录。

- 服务端导出与依赖预检：[服务端离线导出](docs/服务端离线导出.md)。
- 行内平台部署：[行内云平台部署 Node.js 服务教程](docs/行内云平台部署Node.js服务教程.md)。
- 插件发布：`pnpm run release:extension -- "本次更新说明"`，自动增加 patch 版本并生成交付文件；构建前需配置 `WXT_PUBLIC_AGENT_SERVICE_URL` 为实际服务地址。

部署时配置安装身份、持久化数据目录及稳定的身份签名密钥，确保重启后仍可访问历史副本。当前 Dockerfile 的数据目录为 `/opt/deployments/data`。

依赖以行内已验证锁文件为基线，不随安装或导出升级。新增依赖或变更版本前，需确认行内源提供对应版本及平台包；导出成功不代表依赖预检通过。

## 工程与验证

```text
apps/extension                     Chrome 插件、页面捕获、选区与 Side Panel
apps/agent-service                 HTTP 服务、工作区、版本历史与日志
packages/agent-runtime             Cline SDK 适配、受控源码工具与模型指令
packages/replica-component-runtime 副本中的 React / Ant Design 运行时
packages/contracts                 共享协议与数据校验
```

```bash
pnpm typecheck     # 类型检查
pnpm architecture # 依赖边界检查
pnpm build        # 构建
```

按项目协作约定，后续改动默认不新增、不运行单元测试；功能和页面效果由用户在真实场景中验证。工程方案须面向不同网页形态，具体原则见 [AGENTS.md](AGENTS.md)。

## 文档入口

- [Agent 日志排查说明](docs/Agent日志排查说明.md)
- [网页转静态副本技术详解](docs/网页转静态副本技术详解.md)
- [静态快照工作台技术方案](docs/UI辅助需求编写插件_静态快照工作台技术方案.md)
- [副本编辑与真实渲染验证实施方案](docs/UIAgent_副本编辑与真实渲染验证实施方案.md)
- [更多资料](docs/) · [历史方案归档](docs/archive/)

专题文档包含阶段性设计与历史记录；当前命令、配置和行为以代码为准。
