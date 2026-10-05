# 本机插件端到端回归

这是独立的本机测试工程，不属于 pnpm 工作区，不修改根 pnpm-lock.yaml，也不进入行内服务运行依赖。需要 Node.js 22+、项目现有依赖，以及图形桌面环境。

## 安装和运行

在仓库根目录：

```sh
npm --prefix tooling/e2e ci --ignore-scripts
node tooling/e2e/node_modules/playwright/cli.js install chromium
npm --prefix tooling/e2e test
```

只运行普通流场景：

```sh
npm --prefix tooling/e2e test -- --grep 'flow:'
```

查看报告：

```sh
npm --prefix tooling/e2e run report
```

测试自动创建临时服务、随机端口、独立副本目录和浏览器用户目录；构建连接测试服务的插件到临时目录。不读取 `.env`，不使用现有浏览器用户数据、不覆盖 `.output`、不连接 COS 或真实模型。正常结束清理临时环境；进程强制终止时可能留下系统临时目录 `uiagent-e2e-*`。

若已离线获取同版本配套 Chromium，可通过 `E2E_CHROMIUM_EXECUTABLE` 指向其可执行文件；不要使用用户日常 Chrome 或随意替换浏览器版本。

## 已实现覆盖（15 个本机场景 + 1 个可选真实 COS 场景）

对普通流、flex、grid、定位容器、滚动区域分别执行：

1. 打开仅含悬浮入口的测试站点（fixture.test 映射到本机）。
2. 从悬浮入口打开真实浏览器侧栏，验证 CDP 中存在原生侧栏目标。
3. 点击进入副本编辑，验证动态注入采集脚本、服务创建副本和预览加载。
4. 选择标题，等待超过编辑器租约的 8 秒，确认心跳保留选区。
5. 在侧栏提交需求，由固定模型替身使用真实源码工具修改所选元素。
6. 检查浏览器实际渲染出的文本、可见性和非零尺寸，以及其他标题未被修改。
7. 撤销、重做并检查预览结果。
8. 普通用户看不到日志入口，访问 `/logs` 返回 403。

另外 7 个交互及脚本场景：

- 创建请求到达服务后暂停，切换其他 tab，再放行；确认原 tab 打开副本、新 tab 内容和焦点不变，返回后仍能修改原副本。
- 真实 SSE 分段输出超过一屏：自动跟随底部、鼠标滚轮上滚暂停、回到底部恢复跟随。
- 300×600 的真实侧栏视口：24 个长名称、长描述技能，验证面板边界与滚动、实际鼠标点击开关、刷新侧栏后的状态保存，并保存截图。
- Python 成功：执行真实脚本，校验产物 SHA256、进程 ID 和技能调用日志。
- Python 失败：核对退出码 7、stderr 和无产物。
- Python 超时：真实等待触发执行器的 2 秒测试超时，核对 timeout 状态和无产物。
- Python 取消：确认进程已启动后从界面停止，核对中止日志。失败、超时和取消后均确认进程与临时输出目录已清理，并再执行成功，验证并发槽位释放。

聊天场景复用正式 ClineAssistantChatAdapter、技能工具封装、取消传播和日志记录，只替换模型决策循环。测试技能位于临时目录，由真实 SkillRegistry 加载，使用 Python 3 标准库；要求本机 `python3` 可用。测试脚本允许失败和等待，由固定模型替身选择，未验证真实模型选择技能或正式内置技能的语义。生产的技能目录、超时和其他参数不变。

模型替身只用于这个测试工程，不提供生产接口或特殊业务规则。编辑场景固定把收到的选区文字改为 `E2E updated`，因此这些用例验证工程链路，**不验证模型理解能力**，也不表示所有布局/重叠/裁切均已检查。

本工程通过 Chrome DevTools Protocol 连接侧栏目标，并使用 Chrome `runtime.getContexts` 的 `SIDE_PANEL` 类型确认它是真实侧栏（仅靠 CDP 的 `page` 类型无法区分）。侧栏通过 DOM 操作，网页点击由 Playwright 驱动。侧栏目标缺失会失败，不能用普通扩展标签页替代通过。侧栏中的 DOM 点击和输入不覆盖键盘可访问性或原生输入事件链。

## 持久化回归与真实 COS 入口

默认回归新增 3 个场景：

1. 创建并修改副本，撤销到初始版本，重启真实服务进程；核对副本列表、完整会话数据和版本，刷新侧栏后还能重做与撤销。
2. 使用本机 S3 协议模拟服务，保留对象、删除整个本地 S3 缓存并重启；通过真实 aws-sdk、ZIP 归档和 WorkspacePersistence 恢复同样的数据。
3. 模拟 S3 PUT 返回 HTTP 403，验证失败日志与界面未完成状态、已保存版本未变化；清空缓存重启仍恢复旧版本，恢复写入后可继续修改。

S3 模拟服务只覆盖本项目用到的协议子集，不验证签名、真实桶权限、网络或 COS 兼容性。上传结果不确定（超时、断连但可能已写入）尚未覆盖。

真实 COS 配置准备好后，将 `cos.example.json` 复制为 `cos.local.json`（已被 Git 忽略），填写 Endpoint、Region、Bucket、Prefix。必须使用从未启用版本控制的专用测试桶，保留生产代码对桶策略和读写删除权限的检查。Prefix 格式限定为 `uiagent-e2e/<测试名称>`。

通过终端或运行平台注入以下凭证，不写入 JSON 或代码：

- `WORKSPACE_S3_ACCESS_KEY_ID`
- `WORKSPACE_S3_SECRET_ACCESS_KEY`
- `WORKSPACE_S3_SESSION_TOKEN`（临时凭证需要时）

```sh
npm --prefix tooling/e2e run test:cos -- /absolute/path/to/cos.local.json
```

每次运行在配置前缀下追加独立 UUID，只读写和清理该次运行的对象，保留正式数据。测试在首次保存后清空本地缓存，重启并从远端恢复。清理失败会使运行失败，需要按该次 UUID 人工检查残留。未提供配置时，默认回归明确跳过真实 COS；专用命令缺少配置或凭证会报错退出，不会当作通过。

真实 COS 配置目前未提供，因此仅完成入口，尚未连接真实 COS 验证。

## 证据和范围

结果保存到 `output/playwright/`：HTML 报告、网页 trace、服务日志、浏览器错误，以及失败时的网页截图和侧栏 DOM。技能面板成功时保留截图，Python 用例附带执行结果、清理状态及对应日志。Trace 主要覆盖网页，不应视为侧栏完整操作录像。

本确定性套件尚未实测：真实 COS、Python 后代进程清理与缺少解释器等其他异常。真实模型和内置技能使用另一个入口，参见 [真实模型场景评测](../../docs/真实模型场景评测.md)，不与本套件混算通过率。

原生侧栏需要配套 Chromium 和图形环境，CI 在 Linux 上需要显示服务（如 Xvfb）；当前没有配置 CI。不要把本机通过等同于行内部署或正式 Chrome 已验收。

## 模型速度与失败率优化对比

`optimization-benchmark.mjs` 固定 10 个代表性任务（Q01、E01、M01、L03、C01、C04、C11、C16、D00、D05），覆盖普通流、flex、grid、定位、滚动、真实 React 按钮和表单交互。每阶段 DeepSeek（配置 ID `default`）和 Qwen（`qwen`）各执行 2 次独立重复，每任务均从新副本开始；共 40 个任务/阶段。正式运行前确认 `default` 实际映射的模型，报告保留实际名称。

基线必须从冻结的产品源码目录运行，候选从修改后的源码目录运行，两者使用完全相同的 `tooling/e2e` 和相同绝对输出目录。脚本记录完整评估器、案例、产品源码及页面资产哈希；阶段内源码变化会拒绝混合记录。两模型按任务和重复交替执行，避免整批先跑一个模型。

```sh
# 以下在各自基线/候选源码根目录执行。输出目录应为同一个绝对路径。
node tooling/e2e/optimization-benchmark.mjs run baseline --output-root /absolute/path/to/comparison
node tooling/e2e/optimization-benchmark.mjs run candidate --output-root /absolute/path/to/comparison
# 先分批执行某个模型/重复，未执行任务保留为 planned；不会被算作成功。
node tooling/e2e/optimization-benchmark.mjs run baseline --models default --repeat 1 --output-root /absolute/path/to/comparison
# 核对 evaluation.json 的需求、对话、操作、DOM 和前后截图后，逐任务记录审核依据。
node tooling/e2e/optimization-benchmark.mjs review baseline r1-D00-default passed '文案正确，非目标内容和布局保留；已核对前后截图及刷新结果' --output-root /absolute/path/to/comparison
node tooling/e2e/optimization-benchmark.mjs compare --output-root /absolute/path/to/comparison
```

每轮以点击发送或澄清选项为起点，到任务终态且插件结束生成计时，共用 10 分钟上限。发请求前已保存 attempt；超时仍保留实际等待时长、已取得的路由/模型日志/页面 DOM/对话。没有执行的后续轮次明确保留为缺失；不会只汇总成功轮次。初始环境、浏览器或采集失败独立标为 setup，不能充当模型任务失败或通过，且使完整验收不成立。无自动重试；中断进程遗留的 running 槽位须先检查原进程和证据，脚本不会擅自重启它。

前后分别比较每模型任务失败率，以及同一任务重复中前后都成功的耗时。另报告全计划任务惩罚耗时：失败任务按所有计划轮次的超时预算计入，防止更早失败或跳过后续轮次造成虚假提速。语义未审核不算成功，自动断言通过也不替代语义和视觉审核。两项耗时指标均降低至少 20%、失败率相对降低至少 20%，且没有语义质量回退、缺失记录或环境失败，才显示目标已验证。基线零失败时，相对失败率提升无法计算，不能声称已达到目标；需扩大独立样本或明确另行验收口径。

两次重复是第一轮工程对比，不能据此声称对生产请求具有统计置信度。测试会调用真实模型并产生费用；仍不新增或运行单元测试。

DeepSeek 的提速重点按用户约定放在复杂任务：L03、C01、C04、C11、C16、D05；Q01、E01、M01、D00 保留为简单场景回归，检查耗时和质量是否退步，不要求把几秒任务继续压缩。报告应同时保留全套统计与该预先确定分组的统计，不能根据结果临时挑选较快用例。单个失败必须保留，即使分组内平均耗时改善也不能忽略质量回退。

调优期间的 focused 运行用于定位原因，不能替代完整验收；不同产品版本的结果分别保存，不能把各版最好的任务拼成一轮。多轮任务逐轮检查授权范围：后续功能正确不抵消先前擅自添加功能；自动交互通过也不抵消无效组件 API 导致的样式退步。截图处于加载或动画中时，补做有来源记录的稳定状态核对，不直接推断最终视觉正确或失败。

### 有痕验收纠错

如果原始回归的交互定位器误报，可以用 `recheck-recorded-interactions.mjs` 对已生成页面离线补验；它不调用模型，要求重建后的初始 DOM 和几何/计算样式与原记录逐项精确一致，再实际点击并截图。JSX 来自采集请求和成功 patch，编译器与运行时使用该阶段冻结源码；不宣称完整网络 trace 原样回放。

若唯一 DOM 差异是采集桥留下的空 `style=""` 属性，回放只补回原记录中对应节点的空属性，并记录 `emptyStyleRestoration`；随后仍需通过完整 DOM 和几何精确比对。非空样式或其他结构差异不会被修正或忽略。

`adjudicate-optimization-results.mjs` 只生成新的派生统计目录，保留所有原始 phase、evaluation 和耗时。路径和阶段都需显式传入，不按案例名称做分支：

```sh
node tooling/e2e/adjudicate-optimization-results.mjs \
  --source-root /absolute/path/to/comparison \
  --output-root /absolute/path/to/comparison-adjudicated \
  --notes baseline=/absolute/path/to/semantic-notes.json \
  --notes baseline=/absolute/path/to/supplement-review.json \
  --correction baseline:r1-C11-default=/absolute/path/to/acceptance-supplement.json
```

`--notes` 可重复传入，既支持带 `reviews` 数组的文件，也支持单条审核对象；普通审核须引用原 evaluation，补验审核须绑定补验文件 SHA256。`--correction` 同样可重复，baseline/candidate 使用相同门槛：已有完整记录且结论通过的 Agent 语义与视觉复核、全部原任务轮次完成且非交互检查通过、原失败仅源于角色点击定位及其后续链、补验零模型调用、初始状态精确相等、全部同序操作通过、原文件和 trace 哈希一致。其他模型失败、范围/布局失败、缺失记录或未审核任务不会被改成通过。

复核记录明确标注 `reviewMethod: "agent-semantic-and-visual-review"`；这是 Agent 对源码、几何和截图的复核，不能称为人类用户已验收。用户在真实场景中的验收结果另行记录，当前标为 `userAcceptance: "not-recorded"`。

入口内部调用冻结的 compare 再附加 adjudicated 标识、纠错清单和 `adjudication-audit.json`。不要用原始 compare 单独覆盖派生报告的标记；需要更新时重新执行此入口并指定新目录。新目录已存在会拒绝覆盖。运行中的原 phase 只读取当时快照，不修改，也不调用会与运行器互相覆盖的 review 命令。

每份报告把实际读取的原始 phase 字节保存在 `source-snapshots/`，复核笔记字节按 SHA256 保存在 `review-snapshots/`。审计同时记录原路径、哈希和这份报告内的快照路径；后续原阶段或笔记追加内容不会改变既有快照。

### 单场景隔离重放

`replay-workspace-turn.mjs` 接收原副本目录、成功修改日志、全新输出目录及可选推理策略 JSON。它复制副本并回到日志对应的修改前版本，复用同一请求、模型与凭证，记录源码和运行时哈希、完整耗时与响应；不修改原副本，不自动重试，不把 completed 当成页面效果通过。
回放复用正式服务的模型注册入口，Qwen 与 DeepSeek 的参数映射保持一致。不传策略时沿用日志档位（旧日志默认为 Fast）和当前服务配置；报告中的 `effectivePolicy` 记录本次实际策略。可选参数也支持 `none/low/high/max`，表示将 Fast 的全部编辑阶段统一设为该强度；JSON 则分别配置阶段。覆盖策略仅适用于 Fast，Normal/Pro 日志传入覆盖参数会明确报错，避免静默忽略或改变其核对预算。此覆盖不调整独立核对或过程说明翻译的强度。


```sh
node --env-file=apps/agent-service/.env --import ./apps/agent-service/node_modules/tsx/dist/loader.mjs \
  tooling/e2e/replay-workspace-turn.mjs /absolute/path/workspace /absolute/path/log.json \
  output/real-model/replay-new-run /absolute/path/reasoning-policy.json
```

推理策略只在隔离进程中应用。真实浏览器场景可用 `REAL_EDIT_REASONING_FILE=/absolute/path/reasoning-policy.json` 指定同一策略，不改 `service.local.json` 或部署配置。策略字段为 discovery/planning/execution、可选 verification/correction/layoutExecution，取值 none/low/high/max；必须分别核对实际调用和完成质量。

重放后可用 `serve-replay-preview.mjs 输出目录/workspaces 副本ID` 打开本机随机端口的只读预览；模型执行与写接口关闭。浏览器复核需覆盖用户要求的字段、位置和交互，保留截图与几何事实。不同版本或策略的最好结果不能拼接成验收成绩；外部资源被阻断时应记录这一检查条件。
