# UIAgent 副本编辑与真实渲染验证实施方案

日期：2026-09-06  
状态：工程实现进行中；本文的长期候选验证设计不等于已完成浏览器验收。
读者：接手实现的 AI 编码模型与项目维护者。  
范围：在已验收的 B 副本上理解需求、修改页面、验证结果和提交版本。

> 实施进度（2026-09-06）：M1 已实现候选文档身份（含 A/B 渲染模式）、从正式 Revision 物化不可变候选、候选独立预览、候选覆盖层隔离、预览页实时几何/布局/裁切与就绪观察、受控 PNG 截图 artifact、带候选哈希/模式/租约校验的观察回执，以及扩展候选标签页轮询回传。M2 的候选渲染验证与有限自动修正代码已具备实验入口，但尚未完成浏览器生命周期验收，现由 `CANDIDATE_RENDER_VALIDATION_ENABLED` 控制且默认关闭。关闭时，编辑使用直接 Revision 提交流程；设为 `true` 后才会启用候选、真实渲染、几何验证与自动修正。M3 已补齐该直接提交流程的侧栏重连：运行中的 turn 会持久化，重新打开侧栏后继续查询终态；服务重启导致状态丢失时刷新正式 Revision 并明确告知用户，不把任务误报为已验证。当前模型不支持图片输入，实验路径采用 `geometry-v1`，不把截图伪装成模型视觉审查。类型检查已通过；未执行浏览器验收或测试。

## 1. 已确定的决策与使用方式

用户已反馈多个网站的副本生成验收通过。当前生成阶段按约定范围收口：B 为默认且唯一的生成载体，A 仅保留为可配置的回退/诊断用途（`REPLICA_A_ENABLED=false`）。关闭 A 时若捕获结果没有可用作者样式资源，创建会明确失败，不会静默生成冻结计算样式副本。此反馈是人工样本验收，不等于历史实验协议中全部 G1 指标通过。

本阶段不再比较或更换副本生成方案，不更换 Agent 框架，不增加多 Agent，不恢复原站业务脚本。复用当前单一规划 Agent、通用源码工具、插件、服务和历史记录。

交付目标：用户在副本选择区域并提出需求，Agent 根据当前页面证据理解目标，修改隔离候选版本，获得浏览器实际渲染证据，验证通过后保存可撤销的 Revision。首期针对固定视口的静态需求示意，支持连续编辑；不承诺生产代码、真实接口或任意响应式效果。

实施模型先阅读项目 AGENTS.md，再阅读本文及本文引用的现有代码。本文的接口和新文件名是拟定设计，需落为实际类型和实现，不能把示例当成已存在 API。旧文档的历史状态如有冲突，以最新用户决定、当前代码及本文明确标注的范围为准。

会话现有约束继续有效：不针对网站或业务类名写兼容，不注入临时 CSS 修补页面，不自行打开预览；用户此前还要求暂不新增/执行测试。本文描述未来产品的测量和验收能力，不代表当前允许编码模型自行操作浏览器或执行测试。实施可完成代码、静态检查；涉及真实浏览器验收或测试执行时需要用户明确恢复相应授权。不要把未执行写成已通过。

## 2. 现有基础与真正的缺口

以下为本次代码检查结果，而非完整运行验证：

| 能力 | 现有实现 | 本阶段改造 |
| --- | --- | --- |
| 意图声明 | Adapter 有 declare_intent 和写入门禁 | 持久化规格、版本、验收条件及证据关联 |
| 澄清 | Adapter 有 clarificationRequested，阻止后续工具 | 服务事务层也强制等待终态，可靠恢复 |
| 元素观察 | inspect_element(s) 提供结构及 capturedRect | 增加实时浏览器观察；明确历史矩形不能验收 |
| 修改 | 通用 DOM 操作、CSS 覆盖、批量原子操作 | 绑定 candidateVersion；每次写入使旧验证失效 |
| 工作副本 | store 的 working 与 original 分离 | 把候选状态变为服务端可寻址、可渲染的对象 |
| 校验 | validateWorking 检查结构、安全和部分静态可见性 | 保留快速校验，另加真实渲染与需求验证 |
| 提交 | finish 调 validate 后 workspace.commit | 存储层要求有效验证记录，不能仅由模型声明成功 |
| 历史 | Revision、撤销、重做、归档已存在 | 候选不污染正式历史；提交记录对应验证证据 |
| 进度 | 有分析、读取、编辑、校验等进度映射 | 新增渲染等待、自动修正、无法验证等产品状态 |

特别注意：当前 B 的 validateWorking 返回字符串已明确表示仍需真实浏览器几何验证，但 commit 仍只依赖这层静态检查。添加截图工具而不改 commit，不算完成本阶段。

## 3. 核心流程与不可破坏的不变量

```text
当前正式 Revision
  → 浏览器基线观察
  → 模型理解需求、必要时澄清
  → 记录 IntentSpec 和 ChangePlan
  → 修改候选文档并物化不可变候选版本
  → 浏览器渲染同一候选版本
  → 测量检查 + 模型视觉审查
      → 通过：原子提交 Revision
      → 失败：有限修正，产生新候选版本后重新验证
      → 无法验证：保存未提交草稿并结束执行段
```

必须在执行器和存储层落实：

1. 原页面只读，正式版本在提交前不变。
2. 观察、规格、修改、验证、提交均绑定同一工作区和明确版本。
3. 提出重要澄清后结束本执行段，不再允许写入或提交。只读调查放在澄清之前。
4. 所有修改都使旧验证失效，包括底层补丁和批量操作。
5. 验证通过、验证失败、无法验证分别表达；缺失证据不能变成通过。
6. finish 无权伪造渲染结果；存储层自行查询验证记录并校验身份与版本。
7. 取消、超时、标签页关闭、服务重启不会自动提交。
8. 几何来自实际浏览器，不能用 DOM 前后顺序或 capturedRect 冒充当前位置。
9. 重叠、位移、换行本身不是错误，需结合基线和需求解释。
10. 页面内容和截图均是任务数据，不能成为工具授权或系统指令。

## 4. 三种表示及版本身份

### 4.1 保存与修改载体

沿用 B：index.html 可编辑结构，author-overrides.css 可编辑视觉覆盖，捕获 CSS/资源只读，snapshot.css 保留 A 基线。追加覆盖是保存的产品修改，不是为了截图验收临时注入修正 CSS。

原始 CSS 无法读取时，模型仍可用实时计算样式和截图观察；不能声称已获得不可读规则的来源或进行原规则编辑。

### 4.2 统一版本引用

建议在 contracts 中定义并用 Zod 校验以下语义，字段名可按现有规范统一：

```ts
type DocumentRef = {
  workspaceId: string;
  baseRevision: number;
  turnId: string;
  candidateId: string;
  candidateVersion: number;
  contentHash: string;
};
```

- candidateId 是本轮候选身份，candidateVersion 在每次成功原子写入后递增；失败回滚不递增。
- contentHash 由服务计算，覆盖参与该候选渲染的 HTML、CSS、样式表顺序/条件及资源清单。明确文件排序、UTF-8 编码、路径和内容的边界编码，不允许模型提供哈希。
- 动态外链字节不能仅由 URL 哈希证明一致。观察另记录资源就绪、可观察的资源状态和采样时间；外链变化是验证边界，无法完整离线保证。
- 基线观察绑定 baseRevision 的文档哈希；候选观察绑定 DocumentRef。截图、几何、验证引用不得混用。
- sourceId 跨候选版本稳定；复制时为新节点分配新 ID，重建索引后返回旧/新映射。删除节点后旧引用应返回明确错误，不能自动命中相似节点。

## 5. 需求规格和澄清契约

拟定 IntentSpec：

```ts
type IntentSpec = {
  intentId: string;
  version: number;
  baseRevision: number;
  userMessageIds: string[];
  goal: string;
  targetSourceIds: string[];
  allowedEditRootIds: string[];
  preserve: Array<{ description: string; sourceIds: string[] }>;
  constraints: Constraint[];
  assumptions: string[];
  clarificationIds: string[];
};
```

Constraint 至少含 id、自然语言描述、来源用户消息/澄清引用、目标引用、required、检查类型和检查参数。新增节点尚未存在时使用 plan-local 引用，执行后解析到真实 sourceId；未解析不得验收。

检查类型建议先提供通用的内容/数量、相对位置、对齐、包含关系和视觉审查。参数包括坐标空间、关系参照、允许偏差以及 required。偏差按明确规格或统一可配置测量政策产生，不允许模型看到失败后随意放宽。

明确需求由模型声明理解后直接执行，不强制额外用户确认。重要歧义必须澄清，例如参照对象、修改边界、新增内容存在两个明显不同结果。普通实现选择由模型承担，不把每个 CSS 属性都抛给用户。

澄清协议：创建 clarificationId → 记录 question/options/上下文引用 → turn 进入 awaiting_user 并终止模型循环 → 新回复必须携带 replyToClarificationId → 新执行段重新检查 baseRevision 并观察。用户没有提交的默认选项不算答案。回复时页面已变，旧计划和几何必须失效。

declare_intent 表示模型声明，不证明歧义已解决。服务只能确定引用、版本和等待状态是否合法，不能用自然语言正则判断语义正确。

## 6. Observation：实时浏览器观察

### 6.1 输入与返回

观察请求包含 DocumentRef、sourceIds、字段选择、范围、分页游标和截图需求；基线观察使用正式 Revision 引用。返回：

- observationId、文档身份、sampledAt、浏览器会话、视口、devicePixelRatio、滚动位置、visualViewport 信息。
- 节点 ID、tag/role、文本摘要、父子关系及兄弟引用。
- 实时 getBoundingClientRect、必要时 getClientRects、有效样式、client/scroll 尺寸。
- 布局相关样式：display、position、flex/grid 参数、尺寸约束、gap、margin/padding、overflow、transform、字体及行高等；完整样式按需读取。
- 实际裁切/滚动祖先链、隐藏原因、可观察的命中测试证据。复杂 clip-path/变换不能仅凭矩形判断可见性。
- 图片、字体、样式表加载状态，已知资源缺失和测量局限。
- 截图 artifactId、内容哈希、像素尺寸、裁剪范围和像素到 CSS 坐标的映射。
- 未返回节点数、截断原因和续读入口。

初始上下文包含选区、所属区域和周边摘要。扩大观察通过分页/字段选择实现，不固定向上两层或固定三个兄弟；不要把整页 CSS 输入模型。

### 6.2 坐标、截图和就绪

几何统一使用 CSS px，显式标注 viewport 坐标或 document 坐标。仅在对应时刻用 scrollX/Y 转换；固定定位、嵌套滚动和 transform 保留事实，不自行反推虚构坐标。

先完成页面加载和关键字体/图片等待，再在配置的时间上限内观察布局稳定性。稳定性政策应版本化，例如连续若干采样中相关节点矩形变化小于规定容差；动画持续变化则返回 unstable，不无限等待，不注入 CSS 冻结画面来掩盖差异。

截图与几何尽量相邻采样，截图前后确认请求、版本、视口和滚动状态未变；不一致则重采或判定不可用。相关区域超过一个视口时使用分段观察并保留每段坐标，不能把不可见区当成不存在。

扩展截图受浏览器标签页可见性/授权约束影响。实现不得假设 captureVisibleTab 能静默截取任意后台标签页；若只能获取活动标签页，应验证当前活动 tab 与请求绑定一致。需要用户切换页面时展示等待状态，绝不截取另一个页面。首期可以明确要求编辑副本保持活动，后续再优化后台渲染。

## 7. 渲染桥：浏览器与服务协作

服务负责候选文档、任务、版本和验证；扩展 background 调度标签页；内容脚本在隔离环境运行可信测量代码。不要执行副本自带脚本，不开放任意 evaluate 作为模型工具。

建议首期复用现有 HTTP 身份认证，增加服务任务队列和扩展主动轮询/领取任务，避免一开始再引入一套 WebSocket 基础设施。轮询只在绑定编辑会话期间进行，考虑 background 被浏览器挂起；服务端 deadline 是最终依据。

拟定 RenderJob：jobId、DocumentRef、intentVersion、baselineObservationId、requestedScope、sessionId、leaseToken、attempt、deadline。tabId 由扩展负责绑定与核验，服务绑定 session/job/身份，不信任网页传入的 tabId。

拟定路由（实施前对照现有鉴权调整）：

| 接口 | 职责 |
| --- | --- |
| GET /v1/workspaces/:id/render-jobs/next | 经认证的扩展领取任务，返回有时限租约 |
| POST /v1/workspaces/:id/render-jobs/:jobId/result | 回传观察、截图引用、就绪状态或明确错误 |
| GET /workspaces/:id/candidates/:candidateId/:version/preview | 只读渲染已物化的不可变候选版本 |
| POST /v1/workspaces/:id/render-artifacts | 受大小/类型限制的截图上传，返回服务生成的 artifactId |

路由是实现提案，不能与已有正式 preview 混用同一可变文件路径。候选 HTML 中 CSS、图片路径必须指向正确工作区/候选版本，尤其注意更深 URL 层级造成的相对路径变化；复用资源链接生成器，不能再次引入 author-sheets/assets 404。

生命周期：服务建立任务 → background 领取 → 加载绑定候选 → 内容脚本握手 → 等待就绪 → 测量/截图 → authenticated result → 服务核对版本和租约 → 唤醒等待该 job 的运行时。

重复回执幂等返回已有结果；旧 attempt、过期租约、取消 turn、错误工作区/身份、错误哈希一律拒绝。网页 postMessage 只能作为受限桥接数据，必须由扩展验证发送者与绑定，不能让网页直接宣称验证通过。

页面 CSP 保持对不可信脚本的限制。使用受控扩展执行环境并验证实际支持方式；不为了测量把 script-src 放宽为任意脚本。预览 token 不能获得写入、领取任务或提交权限。

## 8. ChangePlan 与候选事务

ChangePlan 包含 intentVersion、依据的 observationIds、目标节点、操作列表、预计影响区域、前置条件和验收项映射。模型负责策略选择；程序负责引用、范围、版本和原子执行。

复用现有 replace/set/insert/remove/move/clone/wrap/reorder/batch/patch 能力，不新增业务专用工具。DOM+CSS 的一次逻辑变更必须支持整体回滚，避免一半结构成功、一半样式失败。

建议服务端候选状态：

```text
workspace/
  revisions/                 现有正式历史
  candidates/<candidateId>/
    manifest.json            基线、意图引用、状态、当前版本
    versions/<version>/      不可变候选文件和文档哈希
    observations/            证据索引
    validations/             验证记录
```

这是逻辑布局；可以复用现有存储，不要求重复复制只读资源。候选生命周期和清理策略要记录：正在运行、被用户保留的草稿不能清理；过期候选按明确配置清理，绝不影响正式 Revision。已有用户改动不可自动迁移或删除。

预计影响范围由模型提出，实际影响通过 DOM 变更清单和浏览器差异扩展观察。预期之外的变化先作为事实返回；需要扩大写入范围且改变用户意图时澄清，不按固定祖先数量自动放宽。

## 9. 验证与提交门禁

### 9.1 三层验证

1. 静态检查：HTML/CSS、资源策略、对象引用、批量原子性。沿用现有工具，返回明确 staticChecks 状态。
2. 需求/几何检查：内容、数量、相对关系、对齐、裁切、滚动等。每条 Constraint 返回 pass/fail/unknown、测量值、证据引用。
3. 视觉审查：模型接收基线与候选截图、需求规格、测量差异，判断目标达成和周边损伤，返回结构化结论及 observation/artifact 引用。

同一规划 Agent 可以完成审查，不增加独立 Agent。模型适配层必须真正支持图片输入；图片 URL 字符串不能冒充多模态输入。当前模型没有图片输入，因此启用 `geometry-v1`：只运行前两层，`visualRequired=false` 被持久化在验证记录中，绝不生成虚假的视觉通过结论。未来模型具备能力后，将策略切换为要求第 3 层证据的版本。

基线比较必须使用同视口与对应滚动状态。目标外位移和像素差异先报告，再结合需求判断；不得全页要求“零变化”。继承的基线缺陷与新增缺陷分别记录。不得修改 CSS 只为隐藏验证失败。

### 9.2 ValidationRecord

至少保存 validationId、DocumentRef、intentId/version、baselineObservationId、candidateObservationId、checkPolicyVersion、staticChecks、constraintResults、visualReview、warnings、overall 和时间。overall 为 passed/failed/unverifiable。

只有 required 项全部 pass、每个 intent.sourceIds 均有对应的 `source:<sourceId>` 观察结果、每个 intent.constraints 均有对应的 `constraint:<序号>` 观察结果，并且这些结果引用同一 candidateObservationId 时，才可能为 passed。`source` 检查可以证明目标存在或按需求已删除，不能把“元素仍存在”作为通用前提。浏览器还必须报告布局稳定、字体 ready，以及验证目标自身关联图片无失败且全部 ready；页面其他区域的懒加载或原有资源错误不影响局部验证。若策略要求视觉审查，必要截图也必须属于该候选。模型可以报告审查意见，overall 由确定性聚合器生成，不能接受模型传入 overall=passed 直接放行。

规划阶段的 `verificationSourceIds` 是观察范围：它必须包含目标、容器和所有用来证明约束的同级或关联元素。服务将它与相关目标合并为 intent.sourceIds，浏览器只采样这组元素。约束提到“其他卡片未受影响”却没有将其他卡片纳入观察范围时，验证器必须返回 unknown，不能靠源码或旧的捕获矩形猜测通过。

每个候选至少要有一条约束声明为 `renderConstraintIndexes`。只有当前浏览器几何可直接证明的约束，例如目标存在或删除、容器溢出、裁切、当前对齐或重排，才进入发布门禁；“其他元素保持原样”等需要修改前基线的约束保留为 Agent 的修改范围说明，不阻塞本期发布，也不能让候选在没有任何可验证项时静默进入发布流程。验证结果和逐项原因回写至产生候选的同一条运行日志。

finish 接收 summary 和 validationId，不接受任意自造验证对象。服务查询记录并核验：

- turn 仍可提交，无取消/澄清/超时；身份正确。
- 当前正式 Revision 等于 baseRevision；当前候选版本和哈希等于验证目标。
- 意图版本一致，截图与测量属于该候选和合法渲染会话。
- 验证政策满足当前要求，required 项已通过。

在同一工作区事务/锁内完成核验和发布，采用版本比较避免检查后被其他请求改变。提交先持久化提交身份和候选引用，再写完整 Revision 与正式 manifest；服务若在回执前中断，同一提交身份会比较已写 Revision 的内容哈希并补回同一回执，不能重复发布。故障时正式指针不能指向半写入目录。

无改动 already_satisfied 也必须有当前正式文档对应的验证证据，返回原 Revision，不新增历史。

## 10. 状态机、预算和恢复

```text
observing → planning → applying → rendering → verifying → committed
                 ↘ awaiting_user            ↘ planning（修正）
任何未提交状态 → cancelled / failed / unverifiable
```

awaiting_user、cancelled、failed、unverifiable、committed 都结束本执行段。rendering 是等待浏览器的运行状态，有服务 deadline；unverifiable 是本段无法获得充分证据的终态。明确区分执行段终止和会话仍可继续。

建议初始默认最多两次自动修正，初稿之后的每轮都重新渲染。模型请求预算、浏览器等待上限和工具预算独立配置；预算耗尽不能触发强制 finish，也不能假造澄清让用户替系统诊断。返回实际未完成原因和草稿状态。

取消传播至模型请求、渲染 job 和提交门禁；迟到回执可归档诊断但不能改变终态。服务重启后运行中的 job 租约失效，候选标为 interrupted，不自动继续提交。恢复操作创建新执行段，校验正式基线并重新观察/验证。

同工作区首期只允许一个写入 turn，第二个请求返回 WORKSPACE_BUSY。撤销/重做与写入串行化；复用现有 active 机制但检查它对重启和异步 job 的覆盖能力。

## 11. Agent 工具与提示词调整

新增或升级能力：observe_workspace、expand_observation、declare_intent、propose_change、render_and_check、finish；可以映射到现有命名，不强制全部改名。

底层源码工具可保留，但所有入口经过同一个状态和版本守卫；不能仅在高层 propose_change 上设置门禁。read/inspect 明确区分 sourceFacts、capturedFacts、liveFacts，并附版本。

必须清理现有 Adapter 中这些行为：

- “再次 inspect 捕获数据即可确认没换行/遮挡”的要求。
- 原始规则模式静态 validate 后即可 finish 的路径。
- 尾部强制完成提示在缺少渲染证据时仍催促 finish 的行为。
- 以自然语言关键词 hasExplicitGlobalPlacement 决定布局权限的规则，应迁移到已确认 IntentSpec 及具体范围约束。
- validate_spatial_scope 若仅靠源码层级，应降为结构辅助检查，不再作为真实空间关系验收。

读取预算作为成本保护，不能逼模型信息不足时写入；达到预算上限应返回明确预算状态。日志分开计量模型请求数、工具数、自动修正数与实际 token usage。

## 12. 错误、可观测性与用户体验

建议结构化错误：STALE_DOCUMENT、WORKSPACE_BUSY、CLARIFICATION_REQUIRED、RENDER_SESSION_UNAVAILABLE、RENDER_TIMEOUT、VIEWPORT_MISMATCH、RESOURCE_NOT_READY、LAYOUT_UNSTABLE、VISUAL_INPUT_UNSUPPORTED、VALIDATION_FAILED、VALIDATION_UNAVAILABLE、CANCELLED。错误携带 code/message/retryable/相关 ID，不把认证 token、完整私有页面或凭证写入普通日志。

用户看到：理解需求 → 修改页面 → 检查效果 → 完成。只有等待用户操作、关键歧义、无法完成时给出具体说明，不展示内部哈希和工具参数。

正式版本与“未验证草稿”必须可区分；草稿预览不得带已完成标识，丢弃草稿不影响正式版本。完成消息说明改动和验证范围，用户满意度单独记录；机器通过不能等于用户接受。

每轮保留 trace：需求版本、观察引用、变更清单、渲染耗时、资源状态、逐项验证、修正次数、提交身份、终态。截图走受控 artifact 存储，权限和生命周期与工作区一致。

## 13. 代码落点

以下路径相对仓库根目录，现有文件均已核对：

| 位置 | 工作 |
| --- | --- |
| packages/contracts/src/index.ts | DocumentRef、意图、观察、渲染协议、验证、状态 Zod schema；必要时拆分后统一导出 |
| packages/agent-runtime/src/core/coding-agent-port.ts | 扩展工作区工具端口和模型图像上下文契约 |
| packages/agent-runtime/src/adapters/cline-coding-agent-adapter.ts | 实时观察/渲染工具、意图状态、结构化视觉审查、finish 门禁及提示词清理 |
| apps/agent-service/src/workspace/store.ts | 候选版本、版本守卫、验证记录引用、提交原子性与旧工作区兼容 |
| apps/agent-service/src/app.ts | 候选预览、job/result/artifact 路由，复用鉴权 |
| apps/agent-service/src/progress/source-turn-progress-store.ts | 渲染等待/修正/无法验证状态 |
| apps/extension/entrypoints/background.ts | 渲染会话、任务领取、标签页绑定、截图上传与取消 |
| apps/extension/entrypoints/content.ts | 安装可信测量消息处理器，不改变页面布局 |
| apps/extension/src/messaging.ts | 复用类型化消息机制 |
| apps/extension/src/session/source-workspace-session.ts | 当前候选、渲染会话、澄清和恢复引用 |
| apps/extension/entrypoints/sidepanel/main.tsx | 核对实际 UI 入口后接入状态展示，避免在入口堆积逻辑 |

建议新增独立模块：service/render/render-job-store.ts、service/workspace/candidate-store.ts、service/workspace/validation.ts、extension/content/workspace-observation.ts。名称仅供组织参考，禁止把全部实现继续堆进 app.ts 或 store.ts。类型依赖遵循现有 packages → apps 方向，服务不引用扩展源码。

## 14. 分阶段交付与完成定义

### M1：候选与观察基础

- 建立版本身份和候选只读渲染路径，复用同一 CSS/资源组装逻辑。
- 建立渲染会话、真实几何和截图回执，拒绝过期/错误版本。
- 交付：能将一份未提交候选与其真实观察绑定，正式 Revision 不变。

### M2：编辑、验证和提交闭环

- 持久化意图，接入逐项几何检查；模型具备图像输入后再启用视觉审查。
- 所有写入使验证失效；存储层实现验证后提交门禁。
- 交付：明确需求可完成一轮修改；失败进入有限修正；缺证据不能提交。

### M3：恢复、连续编辑与验收

- 恢复异常处理已补充：普通执行与侧栏重连共用进度查询；请求回执不确定或终态后的刷新/对话保存失败时保留任务引用，自动退避重试（最长间隔 15 秒），不重新提交修改请求。任务未确认期间禁止新一轮发送与历史操作；查询到任务丢失后刷新正式副本并提示。以上为代码实现，尚待浏览器故障场景验收。
- 澄清恢复、取消/断线/超时/重启、三轮编辑及撤销重做。
- 管理未验证草稿与证据生命周期，完成运行报告。
- 交付：通过获授权的多布局验收，且没有验证前提交、旧证据复用或不可恢复历史损坏。

每个里程碑保持可运行。新闭环可通过版本化能力标识逐步启用；旧模式若暂时保留必须标为旧的未完成视觉验证模式，不能新路径失败后静默走旧 finish 成功。

## 15. 验收矩阵（执行前遵守用户测试/浏览器授权）

| 类别 | 最少覆盖 | 不变量 |
| --- | --- | --- |
| 文本/属性 | 长文案、按钮状态、字体变化 | 内容准确，实际换行与裁切已观察 |
| 结构 | 插入、复制、移动、删除 | 新 ID 唯一，引用有效，布局由模型依据页面规划 |
| 布局 | 普通流、flex、grid、定位、可滚动区域 | 不依赖固定层级、尺寸、站点或业务 class |
| 需求 | 明确描述、歧义描述、无需修改 | 只在必要时澄清，已满足也有证据 |
| 连续编辑 | 至少三轮，含撤销/重做 | 以当前 Revision 为基线，历史内容可恢复 |
| 版本 | 验证后再修改、旧回执、重复 finish | 旧证据拒绝；重复提交幂等 |
| 故障 | 取消、关闭标签页、资源不就绪、重启 | 终态正确，没有半成品提交 |
| 多模态 | 截图缺失、错误活动 tab、无图像模型 | 返回不可验证，不拿文字代替视觉成功 |
| 资源 | 多级候选 URL、已知外链缺口 | 本地路径正确，缺失明确标记 |

先静态检查；获得授权后实施契约测试和实际浏览器验收。不要编写只复刻某个真实网站 DOM 的测试，不把测试代码数量当完成度。人工记录每条需求的输入、基线/结果、是否接受、需纠正次数以及未完成原因，不虚构总体成功率。

## 16. 给接手编码模型的执行要求

1. 先核对实际工作树和 AGENTS.md；保留所有未提交用户改动，不回滚生成阶段代码。
2. 列出本文契约与实际接口的对应关系，再实施 M1。明确新建/修改文件和需要迁移的运行状态。
3. 先完成一个纵向路径：候选物化 → 浏览器观察回执 → 版本校验，再扩充检查类型。
4. M2 必须落实服务端提交门禁，不能止于提示词或 Adapter 内布尔标记。
5. 不采用业务关键词布局规则，不临时注入 CSS，不把源码顺序当视觉证据，不绕过澄清/取消状态。
6. 保留普通/失败/无法验证路径，报告“实现完成”“静态检查通过”“实际验收通过”三种不同状态。
7. 当前明确请求是方案文档；后续用户让你写代码时按上述阶段执行。浏览器和测试操作遵守当时明确授权，不把本文当权限扩张。

参考：UIAgent_核心能力重设计与验证计划.md（总体原则）、UIAgent_阶段进展与后续工作交接.md（历史实现与约束）。本文件负责本阶段实施细节，不修改既有生成方案的验收结论。
