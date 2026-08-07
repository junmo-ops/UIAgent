# UIAgent 项目交接上下文

> 用于新会话、新成员或跨电脑开发时快速恢复项目背景。本文不包含任何 API Key、Cookie 或敏感配置。

## 1. 项目位置与当前状态

仓库路径：

```text
/Users/moxiaojun/Documents/UIAgent
```

当前分支：`main`

当前工作区干净，最近提交：

```text
50443f7 重构静态副本代码目录
02ad14b 优化代码架构
55ca997 比赛材料
b12f414 fix: 修复UI 快照还原问题
195511b feat: 支持远程部署
```

## 2. 产品定位

UIAgent 是一个面向产品经理的 Chrome 插件 Demo，用于快速生成 UI 需求示意。

当前正式方案是：

> 先把原页面冻结为安全的静态源码副本，再修改副本中的 HTML/CSS。

完整流程：

1. 用户打开普通 HTTP/HTTPS 页面。
2. 插件捕获页面当前已渲染的 DOM、表单状态和主要可见样式。
3. 系统移除脚本、事件、接口、iframe、表单提交和远程资源。
4. Agent Service 创建静态源码工作区。
5. 插件打开副本页面。
6. 用户在副本中选择目标区域。
7. 用户通过自然语言描述 UI 修改。
8. 源码 Agent 使用受控工具修改 HTML/CSS。
9. 用户可以继续对话、撤销、重做、恢复初始版本或导出截图。

旧的“直接修改当前页面 DOM”方案已经删除，不要重新引入两套编辑链路。

## 3. 当前能力

- 页面捕获与安全清洗。
- 静态源码工作区。
- 副本页面选区和高亮。
- HTML/CSS 源码 Agent 编辑。
- 文案、组件、布局和样式修改。
- 新增元素默认围绕当前选区或最近语义祖先定位。
- 明确指定页面顶部、底部、全局、固定或悬浮位置时才扩大定位范围。
- 多轮对话修改。
- 按 Revision 撤销、重做和恢复初始状态。
- 当前可视区域截图导出。
- 离线快照包导出和导入。
- Mock Agent、Legacy Source Agent 和 Cline Adapter。
- DeepSeek/OpenAI-compatible 模型接入。
- Agent 会话日志和实时进度展示。

## 4. 工程结构

```text
apps/demo-page
  固定 React + Ant Design 测试页

apps/extension
  WXT Chrome MV3 插件
  entrypoints/
    background.ts
    content.ts
    sidepanel/main.tsx
    workspace-loading/
  src/content/
    页面捕获、选区和受控交互
  src/session/
    编辑标签页绑定和页面访问策略
  src/service/
    Agent Service 地址和运行配置
  src/snapshot/
    离线快照包导入导出
  src/sidepanel/
    SidePanel 应用实现

apps/agent-service
  Hono Agent Service
  src/workspace/
    静态源码工作区、编译、校验和版本历史
  src/progress/
    Agent Turn 进度
  src/observability/
    日志存储和日志页面

packages/agent-runtime
  src/core/
    CodingAgentPort、Checkpoint 等通用 Agent 接口
  src/adapters/
    Cline Adapter、Legacy Adapter
  src/source-editing/
    静态源码编辑 Agent 和受控交互指令

packages/contracts
  @ui-agent/contracts
  版本化协议、DTO 和 Zod Schema
```

## 5. 已删除内容

以下内容已经退出当前实现：

- `DomEngine`
- `packages/ui-change-agent`
- `packages/ui-change-domain`
- `packages/ui-change-eval`
- `apps/challenge-runner`
- `apps/extension/entrypoints/evaluation`
- `SnapshotStore`
- `/v1/snapshots`
- `/snapshots/:snapshotId`
- `/v1/turns`
- `/v1/turns/:turnId/execution`
- `SelectedContext`、`ChangePlan`、`ExecutionReceipt` 等旧协议
- 旧的 Side Panel session machine

历史文档位于：

```text
docs/archive/
```

当前正式技术方案：

```text
docs/UI辅助需求编写插件_静态快照工作台技术方案.md
```

## 6. 本地运行

要求：

- Node.js 24
- pnpm 11
- 最新版 Chrome

进入项目根目录：

```bash
cd /Users/moxiaojun/Documents/UIAgent
```

安装依赖：

```bash
pnpm install
```

如果系统没有 `pnpm`：

```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install
```

启动测试页：

```bash
pnpm dev:page
```

启动 Agent Service：

```bash
pnpm dev:service
```

启动插件：

```bash
pnpm dev:extension
```

默认地址：

- 测试页：`http://127.0.0.1:5173`
- Agent Service：`http://127.0.0.1:8787`
- 插件开发产物：`apps/extension/.output/chrome-mv3`

验证命令：

```bash
pnpm check
pnpm build
```

最近验证结果：

- 19 个测试文件。
- 75 条测试全部通过。
- TypeScript 类型检查通过。
- dependency-cruiser 架构检查通过。
- Demo 页面、插件和 Agent Service 构建通过。

## 7. 使用流程

1. 打开需要制作示意的原页面。
2. 点击插件图标打开 Side Panel。
3. 点击“进入副本编辑”。
4. 等待插件创建并打开静态副本。
5. 在副本页面点击“选择”，选中目标区域。
6. 输入自然语言修改要求。
7. 根据需要继续对话、撤销、重做或导出截图。

插件使用 `activeTab` 临时权限，不申请 `<all_urls>` 长期权限。`chrome://`、Chrome Web Store 等浏览器保护页面不支持注入。

## 8. 模型配置

服务端环境文件：

```text
apps/agent-service/.env
```

示例配置：

```env
MODEL_MODE=remote
MODEL_PROVIDER=deepseek
MODEL_BASE_URL=https://api.deepseek.com
MODEL_API_KEY=你的Key
MODEL_NAME=deepseek-v4-flash
CODING_AGENT_ADAPTER=legacy
```

可选 Adapter：

```env
CODING_AGENT_ADAPTER=legacy
```

或：

```env
CODING_AGENT_ADAPTER=cline
```

修改 `.env` 后需要重启 Agent Service，插件无需重新构建。

不要把 API Key 写入插件代码、Git、日志、聊天内容或浏览器存储。

## 9. Agent 安全边界

- Agent 只能操作当前静态副本。
- 只能使用注册的源码工具。
- 不能使用 Shell、任意文件访问、任意网络请求或浏览器控制。
- Patch 只允许修改 `index.html` 和 `snapshot.css`。
- 修改必须经过源码安全校验和结构校验。
- 失败的修改不能形成新的 Revision。
- 复杂交互只能使用受控的声明式属性，不能执行原页面 JavaScript。

## 10. 当前待确认问题：公司依赖版本

`apps/agent-service/package.json` 当前使用：

```json
"@hono/zod-validator": "^0.7.0"
```

公司内部 npm 仓库目前只有 `0.4.3`，还没有修改项目依赖。

需要先确认：

1. 公司仓库是否可以同步 `0.7.x`。
2. `0.4.3` 是否支持当前项目的 Zod 4。
3. 如果 `0.4.3` 只支持 Zod 3，需要评估降级 Zod、改用 Hono 原生 `validator`，或让公司仓库补齐新版包。

当前项目还使用：

```json
"hono": "^4.9.0",
"zod": "^4.0.0"
```

不要直接把 `^0.7.0` 改成 `^0.4.3` 后提交，必须先做安装、类型检查和实际请求验证。

## 11. 后续开发原则

- 不要重新引入直接 DOM 编辑链路。
- 不要针对单个测试 Case 硬编码。
- 优先设计通用源码编辑能力。
- 新增元素默认围绕当前选区定位。
- 用户明确描述全局位置时才允许全局定位。
- 不执行原页面 JavaScript。
- 先查看现有代码、日志和测试，再修改。
- 结构重构和功能修改尽量分开提交。
