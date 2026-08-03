# UI 需求示意助手 Demo

面向产品经理的 Chrome 插件 Demo：在固定 PC 测试页选择一个元素，用自然语言生成受控的静态 UI 修改，并支持删除确认、逐步撤销/重做和当前可视区域截图。

## 当前能力

- Chrome Side Panel 与页面元素选择、高亮；侧栏会话固定绑定到打开时的标签页。
- 选区静态快照：冻结当前表单状态和可见样式，移除原页面脚本、事件、接口与外链资源，在本机隔离页面中继续编辑。
- 选区局部 DOM、相邻元素和可见样式提取。
- 添加按钮、文字、链接、输入框、下拉框、单选和多选。
- 修改已有或本轮新增元素的文案与白名单样式。
- 删除已有元素前确认。
- 按用户轮次进行撤销、重做和恢复初始状态。
- 导出当前浏览器可视区域 PNG。
- LangGraph + Vercel AI SDK 的可替换 Agent Runtime。
- 两阶段 Agent Turn：浏览器执行后回传逐操作回执和最新局部 DOM，由 Agent 完成确定性验证。
- GoalSpec 目标驱动规划：先声明组件语义、内容、位置、状态和保持约束，再由能力注册表编译原子操作。
- 渐进式页面上下文：首轮只发送最小选区事实，Planner 可按需申请相邻、样式、结构和会话变更；单 Turn 最多 5 轮规划。
- 定向外观复用：首轮提供轻量元素索引，模型按元素 ID 申请样式，并通过受控 `copyStyles` 复用真实外观而非猜测 CSS。
- 执行后基于原始 GoalSpec 验证页面事实，避免错误计划仅凭自身操作回执“自证成功”。
- DOM 事务失败时自动回滚，并在安全范围内最多生成一次修正计划。
- 默认 Mock Planner，无模型 Key 也能演示核心流程。
- 列表页、详情页、表单页三类 V1.1 固定场景和 20 条模型回归任务。
- C 组 12 条能力上限挑战场景，以及结果导向的运行编排和确定性评分内核。

## 工程结构

```text
apps/demo-page             固定 React + Ant Design 测试页
apps/extension             WXT Chrome MV3 插件
apps/agent-service         Hono Agent Service
packages/agent-runtime     LangGraph、Mock/远程模型 Planner
packages/ui-change-agent   UI Change Agent 两阶段协调、验证与修正预算
packages/ui-change-eval    挑战场景、运行编排和确定性评分
packages/ui-change-domain  UI 变更策略和安全边界
packages/ui-change-contracts 版本化 DTO 和 Zod Schema
```

## 本地运行

要求 Node.js 24、pnpm 11 和最新版 Chrome。

```bash
pnpm install
pnpm dev:page
pnpm dev:service
pnpm dev:extension
```

也可以分别启动三个命令。默认地址：

- 测试页：`http://127.0.0.1:5173`（侧边菜单可切换列表页、详情页和表单页）
- Agent Service：`http://127.0.0.1:8787`
- 插件开发产物：`apps/extension/.output/chrome-mv3`

首次使用：

1. 打开测试页。
2. 在 `chrome://extensions` 开启开发者模式，加载插件开发产物。
3. 点击插件图标打开 Side Panel。
4. 点击“重新选择页面元素”，再点击测试页中的“查询”按钮。
5. 输入“在它右侧增加一个筛选项，选项包括‘全部’‘待审核’‘已通过’”。

插件使用 `activeTab` 临时授权，也可以在任意普通 HTTP/HTTPS 页面上测试：先切换到目标标签页，再点击 Chrome 工具栏中的插件图标，随后点击“重新选择页面元素”。页面跳转或切换标签后需要重新点击插件图标授权。`chrome://`、Chrome Web Store 和其他浏览器保护页面不支持注入；插件不申请 `<all_urls>` 长期权限。

### 使用静态源码副本

1. 保持 Agent Service 运行，在需要制作示意的原页面打开插件。
2. 点击“进入副本编辑”，插件会复制当前已渲染页面，无需提前选择区域或输入需求。
3. 加载标签页随后自动切换为 `http://127.0.0.1:8787/workspaces/{id}/preview`。
4. 在副本页点击“选择”，选中需要调整的区域，再通过输入框描述需求。
5. 后续可以继续对话和重新选区，并可逐步撤销、重做、恢复初始版本及导出截图。
6. 点击 Side Panel 顶部“原页面”可切回来源标签页。再次回到副本时会恢复 Workspace 和对话。

静态源码副本会冻结当前输入值、勾选状态、展开状态和浏览器计算后的主要可见样式，并编译为 Agent Service 本地目录中的 `index.html`、去重后的 `snapshot.css`、语义结构 `outline.json` 和定位信息 `source-map.json`。HTML 与 CSS 会随每轮 Revision 一起保存、撤销和重做。源码 Agent 通过 Outline、搜索、局部读取、精确替换、校验和提交工具工作，不接收旧模式的完整 `SelectedContext`，也不能使用 Shell、网络或访问其他目录。

捕获阶段会移除原始 JavaScript、事件处理器、iframe、表单提交和 HTTP/HTTPS 外链资源，预览页再通过 CSP 禁止接口、脚本与页面导航。复杂伪元素、跨域图片、Web Font、Canvas、动画和依赖 JavaScript 的交互不会完整保留；此模式的目标是生成静态需求示意，不是复制真实业务系统。

## 接入 DeepSeek

在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建 API Key，然后配置服务端：

```bash
cd apps/agent-service
cp .env.example .env
```

编辑 `.env`，把 `MODEL_API_KEY` 替换成自己的 Key，然后回到仓库根目录重启 Agent Service：

```bash
cd ../..
pnpm dev:service
```

默认使用 `deepseek-v4-flash`，适合 Demo 的低延迟规划；如需更强的复杂指令理解，可改为 `deepseek-v4-pro`。不要把长期 Key 写入插件代码、浏览器存储或提交到 Git。

可打开 `http://127.0.0.1:8787/health` 确认当前模型和 Coding Agent。静态源码模式支持两套可切换实现：

- `CODING_AGENT_ADAPTER=legacy`：现有 Source Editing Agent，作为稳定回退。
- `CODING_AGENT_ADAPTER=cline`：Cline SDK 通用源码 Agent POC，需要 Node.js 22 或更高版本；可用 `CLINE_MAX_ITERATIONS` 调整单轮最大迭代数，默认 30。

Cline 只会获得当前静态副本的搜索、局部读取、样式规则直读、结构化移动与克隆、精确替换、受控 Patch、校验、提交和澄清工具；除正常调用模型接口外，不向 Agent 开放 Shell、任意网络请求、浏览器或任意文件访问工具。移动和克隆按 `sourceId` 操作并保留完整结构与样式；Patch 只允许修改 `index.html` 和 `snapshot.css`，支持原子替换及在文件开头、末尾或唯一锚点旁插入，校验失败不会形成 Revision。切换 Adapter 不改变插件、工作区或预览协议。修改配置后需要停止并重启 Agent Service，Chrome 插件本身无需重新构建。

静态源码编辑期间，Side Panel 会展示“定位元素、读取源码、应用补丁、校验页面、提交修改”等实时操作摘要和模型/工具调用计数。该区域用于解释 Agent 当前在做什么，不展示模型的隐式逐字推理，也不会展示完整搜索或替换源码。

## 查看 Agent 会话日志

Agent Service 会把最近 200 个 Turn 写入本地 JSONL，并提供调试页面。直接 DOM 模式记录局部上下文、模型 Attempt、执行回执和验证结果；静态源码模式记录当前请求、此前对话、Coding Agent Adapter、最终 Checkpoint、每一步搜索/读取/替换决策、工具结果、Revision、模型与工具调用次数和总耗时：

```text
http://127.0.0.1:8787/logs
```

默认日志文件为 `apps/agent-service/.logs/agent-turns.jsonl`，超过约 5 MB 时自动轮转。可通过 `LOG_FILE` 修改位置。日志不会记录 API Key、Authorization、Token、Cookie 或密码等凭证字段，但会包含用户指令和测试页局部 DOM，因此只应在本机测试环境启用和查看。

其他 OpenAI-compatible 模型仍可使用：将 `MODEL_PROVIDER` 改为 `openai-compatible`，并设置对应的 `MODEL_BASE_URL`、`MODEL_API_KEY` 和 `MODEL_NAME`。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm architecture
pnpm build
```

Agent 能力上限验证当前优先人工执行，步骤和 C01～C12 的逐项指令见《[C 组挑战测试方案](./docs/UI辅助需求编写插件_C组挑战测试方案.md)》。实验性的自动化 Runner 已保留在 `apps/challenge-runner`，不影响人工测试，也无需为了当前验证安装 Playwright Chromium。

直接编辑模式只保证当前页面会话，不承诺页面刷新、框架重新渲染或跨页面后保留修改。复杂场景优先使用静态快照工作台，避免原框架重新渲染覆盖示意结果。

需求和技术资料位于 [`docs`](./docs/)。Agent 架构、执行后验证和场景评测见《[V1.1 技术方案](./docs/UI辅助需求编写插件_V1.1技术方案.md)》；静态页面编辑方向见《[静态快照工作台技术方案](./docs/UI辅助需求编写插件_静态快照工作台技术方案.md)》。
