# UI 需求示意助手：腾讯云 CloudBase 部署配置教程

## 1. 目标

将 UIAgent 的 Agent Service 部署到腾讯云 CloudBase Run，让其他电脑只安装 Chrome 插件即可使用，不再要求每台电脑安装 Node.js、pnpm、项目源码或本地 Agent Service。

部署后的链路为：

```text
Chrome 插件 → CloudBase HTTPS 域名 → Agent Service → DeepSeek
```

> 本教程面向受控 Demo。当前服务尚未实现正式用户鉴权，页面快照也会发送到腾讯云，请勿处理未脱敏的敏感页面。

## 2. 部署前准备

需要准备：

- 腾讯云账号和一个 CloudBase 环境；
- 可用的 DeepSeek API Key；
- 已推送到 GitHub 的 UIAgent 仓库；
- 仓库根目录包含 `Dockerfile`；
- 本地已经安装 Node.js、pnpm，供最终构建插件使用。

不要将真实 API Key 写入 `.env.example`、GitHub、Dockerfile 或插件源码。Key 只配置在 CloudBase 环境变量中。如果 Key 出现在截图、日志或聊天记录中，应立即停用并重新生成。

## 3. 创建 CloudBase 环境

1. 登录腾讯云 CloudBase 控制台。
2. 创建环境时，数据库选择“云数据库（默认）”。
3. 当前 Agent Service 不使用 CloudBase 数据库，这个选择只是环境初始化要求，不需要额外开通 PostgreSQL 或 MySQL。
4. 网络优先选择 CloudBase 默认网络，避免一开始引入自定义 VPC 和 NAT 网关配置。

## 4. 创建云托管服务

在左侧进入“云函数 / 托管” → “服务管理”，创建“Git 平台部署”。

### 4.1 绑定 GitHub

1. 点击 GitHub 授权。
2. 推荐选择仅授权指定仓库，而不是整个账号的所有仓库。
3. 选择包含 UIAgent 最新代码的仓库和 `main` 分支。
4. 打开“启用自动部署”，后续向 `main` 推送代码时，CloudBase 会自动构建和发布新版本。

选择仓库后，应确认仓库根目录存在：

```text
Dockerfile
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
apps/
packages/
```

### 4.2 基础配置

| 配置项 | 值 |
|---|---|
| 服务名称 | `ui-agent-service` |
| 访问端口 | `80` |
| 服务端口 | `8787` |
| 目标目录 | `/` |
| Dockerfile 文件 | 有 |
| Dockerfile 名称 | `Dockerfile` |

访问端口是 CloudBase 的入口端口；服务端口必须与 Agent Service 在容器内监听的端口一致。

### 4.3 环境变量

在“环境变量设置”中使用配置文件方式填写：

```dotenv
HOST=0.0.0.0
PORT=8787
MODEL_MODE=remote
MODEL_PROVIDER=deepseek
MODEL_BASE_URL=https://api.deepseek.com
MODEL_API_KEY=替换为新创建的DeepSeek密钥
MODEL_NAME=deepseek-v4-flash
SOURCE_WORKSPACE_DIR=/tmp/ui-agent/source-workspaces
LOG_FILE=/tmp/ui-agent/logs/agent-turns.jsonl
```

关键配置说明：

- `HOST=0.0.0.0`：允许 CloudBase 网关访问容器中的服务；
- `PORT=8787`：与服务端口保持一致；
- `MODEL_API_KEY`：只保存在 CloudBase，不进入插件；
- `/tmp/ui-agent`：CloudBase 容器中的临时工作目录。

### 4.4 网络、规格和运行模式

| 配置项 | 推荐值 |
|---|---|
| 公网默认域名 | 开启 |
| 内网默认地址 | 关闭 |
| 容器规格 | 1 核 2 GB 起 |
| 运行模式 | 持续运行 |
| 最小实例数 | 1 |
| 最大实例数 | 1 |
| 扩缩容条件 | 不添加 |
| 启动命令 | 留空，使用 Dockerfile 默认命令 |

当前工作区保存在单个容器的临时文件系统中。固定为一个持续运行的实例，可以避免请求被分配到不同实例，也能降低自动缩容导致当前工作区丢失的概率。

## 5. 首次部署与验证

点击“部署”，等待构建和实例启动完成。服务状态变成“正常”后，复制默认域名，例如：

```text
https://ui-agent-service-xxxx.sh.run.tcloudbase.com
```

访问：

```text
https://你的默认域名/health
```

正常响应示例：

```json
{
  "ok": true,
  "modelMode": "remote",
  "modelProvider": "deepseek",
  "modelName": "deepseek-v4-flash",
  "codingAgentAdapter": "cline-sdk"
}
```

如果无法访问，优先检查：

1. 部署版本和实例是否为“正常”；
2. 公网默认域名是否开启；
3. 服务端口是否为 `8787`；
4. `HOST` 是否为 `0.0.0.0`；
5. 构建日志和实例日志中是否有启动错误。

## 6. 回填公网地址

首次部署成功后，点击“更新服务”，在原环境变量末尾增加：

```dotenv
PUBLIC_BASE_URL=https://你的默认域名
```

地址末尾不要加 `/`，也不要删除原有环境变量。保存并重新部署。

`PUBLIC_BASE_URL` 用于生成静态副本的完整预览地址。如果缺少它，反向代理环境下可能返回容器内部地址或错误协议，导致插件无法打开或绑定副本页面。

## 7. 构建远程版 Chrome 插件

在项目根目录执行：

```bash
WXT_PUBLIC_AGENT_SERVICE_URL=https://你的默认域名 \
pnpm --filter @ui-agent/extension build
```

构建产物位于：

```text
apps/extension/.output/chrome-mv3
```

如需生成便于传输的 ZIP：

```bash
WXT_PUBLIC_AGENT_SERVICE_URL=https://你的默认域名 \
pnpm --filter @ui-agent/extension exec wxt zip --browser chrome
```

ZIP 位于 `apps/extension/.output/`。

这个构建变量会同时写入：

- 插件默认 Agent Service 地址；
- 静态副本页面的可信来源校验；
- Chrome Manifest 中精确的服务域名权限。

## 8. 安装和验证插件

在测试电脑上：

1. 解压插件 ZIP；
2. 打开 `chrome://extensions`；
3. 开启“开发者模式”；
4. 点击“加载已解压的扩展程序”；
5. 选择解压后的扩展目录；
6. 打开一个普通 HTTP/HTTPS 页面；
7. 点击插件图标；
8. 确认顶部显示“已连接”；
9. 点击“进入副本编辑”并完成一次修改。

如果此前安装过本地服务版插件，建议先移除旧插件或重新加载新的远程构建目录，避免旧的 `127.0.0.1` 配置干扰验证。

## 9. 常见问题

### 9.1 插件显示 `Failed to fetch`

检查 `/health` 是否可以从该电脑访问，并确认插件构建时使用的是实际 CloudBase 域名，而不是 `127.0.0.1`。

### 9.2 提示静态副本地址无效

确认以下两处完全一致：

- CloudBase 的 `PUBLIC_BASE_URL`；
- 插件构建时的 `WXT_PUBLIC_AGENT_SERVICE_URL`。

协议、域名和端口必须一致。

### 9.3 构建提示找不到 Dockerfile

确认 CloudBase 选择的是正确仓库和分支，目标目录是 `/`，Dockerfile 名称是 `Dockerfile`，且文件位于仓库根目录。

### 9.4 服务能打开，但模型调用失败

检查 DeepSeek Key 是否有效、账户余额是否足够，以及实例日志中的模型接口返回信息。不要在截图中展示 Key。

### 9.5 部署更新后历史快照消失

这是当前 Demo 的已知限制。CloudBase 容器文件系统不是持久存储，重新部署或实例被替换时，历史工作区可能丢失。当前方案只保证实例存活期间的编辑会话。

## 10. 当前安全边界

- 页面快照会通过 HTTPS 发送到 CloudBase；
- DeepSeek Key 只保存在服务端；
- 快照捕获会移除脚本、事件、接口和外链资源；
- 预览页通过 CSP 禁止脚本、接口、表单提交和页面导航；
- 当前服务尚未实现正式用户鉴权；
- 默认域名适用于受控测试，不应直接作为公共生产服务；
- 不应处理包含客户隐私、账号凭证或公司机密的真实页面。

正式产品化前，需要增加用户鉴权、工作区隔离、持久化存储、自动过期清理、日志权限和服务端限流。
