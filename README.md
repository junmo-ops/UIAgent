# UI 需求示意助手 Demo

面向产品经理的 Chrome 插件 Demo：把当前 PC 页面冻结为安全的静态源码副本，再在副本中选区并通过自然语言生成 UI 需求示意，支持多轮调整、撤销/重做和截图导出。

## 当前能力

- Chrome Side Panel、静态副本页面选区和高亮；会话固定绑定到对应副本工作区。
- 冻结当前 DOM、表单状态和浏览器计算样式，移除脚本、事件、接口和远程资源后生成隔离源码工作区。
- 源码 Agent 按需搜索、局部读取并使用受控工具修改 HTML/CSS，可处理文案、组件、布局和样式调整。
- 新增模块默认围绕当前选区定位；用户明确指定页面顶部、底部或全局区域时才扩大范围。
- 按 Revision 逐步撤销、重做和恢复初始状态，并同步回滚对话上下文。
- 导出当前浏览器可视区域 PNG。
- 可替换模型层和 Coding Agent Adapter；默认 Mock 模式无需模型 Key 即可跑通工作区流程。
- Cline 通用源码 Agent 与现有 Source Agent 可切换，二者共享同一套受控源码工具和安全边界。
- 日志页展示模型/工具调用、源码操作、检查点、Revision 和耗时，便于定位复杂场景。

## 工程结构

```text
apps/extension             WXT Chrome MV3 插件
  entrypoints              Background、Content Script 与 Side Panel 入口
  src/content              页面捕获、选区和受控交互
  src/session              编辑标签页绑定与页面访问策略
  src/service              Agent Service 地址与运行配置
  src/snapshot             离线快照包导入导出
  src/sidepanel            Side Panel 应用实现
apps/agent-service         Hono Agent Service
  src/workspace            静态源码工作区、编译、校验与版本历史
  src/progress             Agent Turn 进度
  src/observability        会话日志与日志页面
packages/agent-runtime     Cline SDK Runtime 与 Coding Agent Port
  src/core                 通用 Agent Port 与 Checkpoint
  src/adapters             Cline SDK Adapter
  src/source-editing       受控交互约束指令
packages/contracts          版本化 DTO 和 Zod Schema
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

1. 打开需要制作示意的页面。
2. 在 `chrome://extensions` 开启开发者模式，加载插件开发产物。
3. 点击插件图标打开 Side Panel。
4. 点击“进入副本编辑”，等待插件自动创建并打开静态副本。
5. 在副本页点击“选择”，选中目标区域并输入修改要求。

插件使用 `activeTab` 临时授权，可以捕获普通 HTTP/HTTPS 页面。页面跳转或切换标签后需要重新点击插件图标授权；`chrome://`、Chrome Web Store 和其他浏览器保护页面不支持注入，插件不申请 `<all_urls>` 长期权限。

### 使用静态源码副本

1. 保持 Agent Service 运行，在需要制作示意的原页面打开插件。
2. 点击“进入副本编辑”，插件会复制当前已渲染页面，无需提前选择区域或输入需求。
3. 加载标签页随后自动切换为 `http://127.0.0.1:8787/workspaces/{id}/preview`。
4. 在副本页点击“选择”，选中需要调整的区域，再通过输入框描述需求。
5. 后续可以继续对话和重新选区，并可逐步撤销、重做、恢复初始版本及导出截图。
6. 点击 Side Panel 顶部“原页面”可切回来源标签页。再次回到副本时会恢复 Workspace 和对话。

静态源码副本会冻结当前输入值、勾选状态、展开状态和浏览器计算后的主要可见样式，并编译为 Agent Service 本地目录中的 `index.html`、去重后的 `snapshot.css`、语义结构 `outline.json` 和定位信息 `source-map.json`。HTML 与 CSS 会随每轮 Revision 一起保存、撤销和重做。源码 Agent 通过 Outline、搜索、局部读取、精确替换、校验和提交工具工作，不能使用 Shell、网络或访问其他目录。

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

候选草稿的真实渲染验证目前是实验能力，默认关闭，编辑会直接保存通过静态校验的 Revision。后续要单独评估该流程时，在 `apps/agent-service/.env` 设置 `CANDIDATE_RENDER_VALIDATION_ENABLED=true` 后重启服务即可。

副本生成默认只使用 B 方案（作者 CSS + `author-overrides.css`）。A 方案是冻结计算样式的诊断/回退变体，当前默认关闭；需要排查 B 方案资源问题时，可在 `apps/agent-service/.env` 临时设置 `REPLICA_A_ENABLED=true` 并重启服务。A 关闭时，如果页面没有可用的作者样式资源，创建会明确失败，不会静默生成 A 副本。

可打开 `http://127.0.0.1:8787/health` 确认当前模型和 Coding Agent。静态源码模式统一使用 Cline SDK，需要 Node.js 22 或更高版本；可用 `CLINE_MAX_ITERATIONS` 调整单轮最大迭代数，默认 45；可用 `CLINE_MAX_OUTPUT_TOKENS` 调整单次模型调用的最大输出，默认 8192（包含模型推理）。最后 3 轮会停止扩展读取，强制转入校验、完成或澄清，避免修改完成后因未调用 `finish` 被回滚。

Cline 只会获得当前静态副本的搜索、局部读取、样式规则直读、结构化 DOM 操作、精确替换、受控 Patch、校验、提交和澄清工具；除正常调用模型接口外，不向 Agent 开放 Shell、任意网络请求、浏览器或任意文件访问工具。DOM 工具按 `sourceId` 操作并保留完整结构与样式；Patch 只允许修改 `index.html` 和 `snapshot.css`，支持原子替换及在文件开头、末尾或唯一锚点旁插入，校验失败不会形成 Revision。修改配置后需要停止并重启 Agent Service，Chrome 插件本身无需重新构建。

源码 Agent 的新增模块默认以当前 `selectedSourceId` 或其最近语义祖先为定位锚点；涉及相邻组件时扩展到最近公共父容器。只有用户明确指定页面、浏览器视口、全局、悬浮或固定位置时才允许全局定位。新增元素在提交前必须通过 `validate_spatial_scope` 校验；局部位置描述下新增 `position: fixed` 会被拒绝并要求改用选区容器，无法确定参照容器时返回澄清问题。

静态源码编辑期间，Side Panel 会展示“定位元素、读取源码、应用补丁、校验页面、提交修改”等实时操作摘要和模型/工具调用计数。该区域用于解释 Agent 当前在做什么，不展示模型的隐式逐字推理，也不会展示完整搜索或替换源码。

## 查看 Agent 会话日志

Agent Service 会把最近 200 个源码编辑 Turn 写入本地 JSONL，并提供调试页面。日志记录当前请求、此前对话、Coding Agent Adapter、最终 Checkpoint、每一步搜索/读取/替换决策、工具结果、Revision、模型与工具调用次数和总耗时：

```text
http://127.0.0.1:8787/logs
```

默认日志文件为 `apps/agent-service/.logs/agent-turns.jsonl`，超过约 5 MB 时自动轮转。可通过 `LOG_FILE` 修改位置。日志不会记录 API Key、Authorization、Token、Cookie 或密码等凭证字段，但会包含用户指令和测试页局部 DOM，因此只应在本机测试环境启用和查看。

其他 OpenAI-compatible 模型仍可使用：将 `MODEL_PROVIDER` 改为 `openai-compatible`，并设置对应的 `MODEL_BASE_URL`、`MODEL_API_KEY` 和 `MODEL_NAME`。

## 构建可安装即用的版本

正式交付时不能让插件连接 `127.0.0.1`。需要先把 Agent Service 部署到公司内网或受控 HTTPS 环境，再把该地址写入插件产物。

服务端已经支持容器运行：

```bash
docker build -t ui-agent-service .
docker run --name ui-agent-service \
  -p 8787:8787 \
  -v ui-agent-data:/data \
  --env-file apps/agent-service/.env \
  -e HOST=0.0.0.0 \
  ui-agent-service
```

公司内网试点不需要登录或数据库。部署前在服务端 `.env` 中启用安装身份，并使用密码管理器生成随机密钥：

```env
AUTH_MODE=installation
INSTALLATION_TOKEN_SECRET=至少32字符且不可提交到仓库的随机密钥
INSTALLATION_TENANT_ID=internal-pilot
CORS_ORIGIN=chrome-extension://正式插件ID
# 仅内部试点临时关闭副本身份隔离；正式环境不要关闭
WORKSPACE_IDENTITY_ISOLATION=false
```

插件首次访问会自动领取服务端签名的安装身份并保存在当前 Chrome Profile；默认情况下工作区列表、预览、修改、Revision 和回收站均按该身份隔离。内部试点可临时设置 `WORKSPACE_IDENTITY_ISOLATION=false`，让不同安装身份共享工作区；该配置会关闭工作区的 owner/tenant 访问边界，只能用于受控试点，正式环境必须删除或设置为 `true`。更换电脑或 Chrome Profile 会形成新身份。`INSTALLATION_TOKEN_SECRET` 必须持续保留，随意更换会使已安装插件的凭证失效。

线上环境应由网关提供 HTTPS，并限制为受信任的公司网络或增加统一鉴权。不要把 DeepSeek Key 写入插件或提交到仓库。
反向代理或容器平台终止 HTTPS 时，还应设置 `PUBLIC_BASE_URL=https://实际服务域名`，确保服务返回的副本地址也是正确的 HTTPS 地址。

构建插件时设置公开的服务根地址：

```bash
WXT_PUBLIC_AGENT_SERVICE_URL=https://ui-agent.example.com pnpm --filter @ui-agent/extension build
```

构建产物位于 `apps/extension/.output/chrome-mv3`。该服务地址会同时用于 API 请求、副本页面校验和精确的 Chrome 主机权限；安装这个构建产物的用户不需要在自己的电脑上启动 Agent Service。插件顶部会真实检测 `/health`，分别展示“连接中”“已连接”或“未连接”，网络失败时会提示实际服务地址，不再只显示 `Failed to fetch`。

远程服务至少需要持久化 `/data`，其中包含静态工作区与操作日志。当前安装身份适合公司内网受控试点：它提供浏览器安装级隔离，但不等同于员工账号登录；服务仍不应直接暴露到公共互联网。正式多端使用时再接入公司 SSO，并将安装身份下的工作区迁移给员工账号。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm architecture
pnpm build
```

当前自动化测试覆盖静态副本捕获、源码工具、版本历史、受控交互、Agent Adapter 和服务接口。旧 DOM Agent 的 C 组测试已移入 [`docs/archive`](./docs/archive/) 作为历史资料。

需求和技术资料位于 [`docs`](./docs/)。当前实现以《[静态快照工作台技术方案](./docs/UI辅助需求编写插件_静态快照工作台技术方案.md)》为准；早期直接 DOM 方案文档仅保留为决策历史。腾讯云部署步骤见《[CloudBase 部署配置教程](./docs/UI辅助需求编写插件_CloudBase部署配置教程.md)》，架构原理见《[云端架构科普教程](./docs/UI辅助需求编写插件_云端架构科普教程.md)》。
