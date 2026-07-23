# UI 需求示意助手 Demo

面向产品经理的 Chrome 插件 Demo：在固定 PC 测试页选择一个元素，用自然语言生成受控的静态 UI 修改，并支持删除确认、逐步撤销/重做和当前可视区域截图。

## 当前能力

- Chrome Side Panel 与页面元素选择、高亮；侧栏会话固定绑定到打开时的标签页。
- 选区局部 DOM、相邻元素和可见样式提取。
- 添加按钮、文字、链接、输入框、下拉框、单选和多选。
- 修改已有或本轮新增元素的文案与白名单样式。
- 删除已有元素前确认。
- 按用户轮次进行撤销、重做和恢复初始状态。
- 导出当前浏览器可视区域 PNG。
- LangGraph + Vercel AI SDK 的可替换 Agent Runtime。
- 两阶段 Agent Turn：浏览器执行后回传逐操作回执和最新局部 DOM，由 Agent 完成确定性验证。
- DOM 事务失败时自动回滚，并在安全范围内最多生成一次修正计划。
- 默认 Mock Planner，无模型 Key 也能演示核心流程。
- 列表页、详情页、表单页三类 V1.1 固定场景和 20 条模型回归任务。

## 工程结构

```text
apps/demo-page             固定 React + Ant Design 测试页
apps/extension             WXT Chrome MV3 插件
apps/agent-service         Hono Agent Service
packages/agent-runtime     LangGraph、Mock/远程模型 Planner
packages/ui-change-agent   UI Change Agent 两阶段协调、验证与修正预算
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

可打开 `http://127.0.0.1:8787/health` 确认返回 `modelMode: "remote"`、`modelProvider: "deepseek"` 和当前模型名。修改配置后需要停止并重启 Agent Service，Chrome 插件本身无需重新构建。

## 查看 Agent 会话日志

Agent Service 会把最近 200 个 Turn 的当前请求、局部 DOM 上下文、此前对话、模型结果、逐操作执行回执、执行后观察、验证结果、错误和耗时写入本地 JSONL，并提供调试页面：

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

当前 Demo 只保证本地或明确测试环境中的当前页面会话，不承诺页面刷新、框架重新渲染或跨页面后保留修改。

需求和技术资料位于 [`docs`](./docs/)。下一阶段的架构增量、Agent 执行后验证、场景评测和实施计划见《[V1.1 技术方案](./docs/UI辅助需求编写插件_V1.1技术方案.md)》。
