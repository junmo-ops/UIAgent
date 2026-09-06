# UIAgent 阶段进展与后续工作交接

日期：2026-09-05  
项目路径：`C:\Users\Administrator\.codex\worktrees\9638\UIAgent`

## 0. 2026-09-06 最新交接入口

用户反馈多个网站的副本生成验收通过，生成阶段按当前范围收口：默认只生成 B，A 通过 `REPLICA_A_ENABLED` 保留按需回退/诊断入口，默认关闭；外链依赖与离线能力边界继续保留。这是人工样本验收，不代表历史 G1 实验矩阵全部执行通过。

当前“生成 B 副本 → 理解需求 → 修改并直接提交 Revision → 连续编辑与历史恢复”的流程按约定范围收口，M3 的直接提交流程已获用户人工验收通过。详细设计和阶段边界见 [副本编辑与真实渲染验证实施方案](UIAgent_副本编辑与真实渲染验证实施方案.md)。下文保留历史记录；历史待实施、待验证状态与本节冲突时，以本节为准。

### 本次验收记录（2026-09-06）

验证执行者为用户，反馈为“这几个场景都没有问题”，对应上一轮提供的四项场景：

| 场景 | 验收内容 | 用户反馈 |
| --- | --- | --- |
| 连续编辑 | 三轮修改后撤销、重做，核对页面与对话 | 通过 |
| 关闭侧栏 | 修改执行中关闭并重开侧栏，恢复进度或最终结果 | 通过 |
| 停止修改 | 执行中停止，任务结束后继续编辑 | 通过 |
| 服务重启 | 执行中重启本地服务，不持续卡住，已保存副本可继续使用 | 通过 |

此前用户已反馈两个编辑场景整体无问题。本轮未新增逐场景日志、截图或版本编号，以上记录依据用户反馈，不扩展为完整自动测试或全部布局矩阵通过。最近一轮代码检查的全项目类型检查及 `git diff --check` 通过；编码 Agent 未自行打开浏览器验收。

### 当前稳定使用范围与后续事项

- 当前使用直接 Revision 提交流程，页面效果由用户人工验收；本次收口不表示自动视觉验证完成。
- `CANDIDATE_RENDER_VALIDATION_ENABLED=false`：候选渲染、几何验证及有限自动修正保留为实验能力。候选恢复、草稿/证据生命周期及该路径的完整浏览器验收留待独立推进。
- 当前模型不支持图片输入，不接入模型图片审查；未来具备能力后再规划。
- 外链资源仍可能依赖原站，不承诺完整离线还原或原站业务交互。
- 本次形成文档层面的阶段基线，未创建 Git 提交、标签或发布包。

## 1. 当前目标

重新审视 UIAgent 的核心方案，解决复杂 UI 修改效果差、Agent 搜索低效、副本体积过大、样式还原不稳定的问题。

工程原则：

- 通用方案优先，禁止根据网站、URL、文案、业务 class、固定 sourceId 做特判。
- 模型负责语义理解、歧义判断和布局决策。
- 程序负责协议、状态、安全边界、事务和可观测事实。
- 没有真实渲染验证，不得声称视觉结果正确。
- 不把单个 Case 的修复当成通用能力。

## 1.1 2026-09-05 实测更新（以本节为准）

用户以相同视口手动比较了 DeepSeek 开放平台用量页、掘金文章页与哔哩哔哩首页，结论是 B（原始规则）整体比 A（冻结计算样式）更接近原页面。因此 B 从“仅实验入口”调整为当前优先编辑载体；A 保留为兼容基线与回退候选。

本轮已确认的通用修复：

- 捕获安全的运行时 inline style，并保留 body 的 class、语言和方向上下文，修复原规则副本丢失布局状态的问题。
- author.css 中图片与字体统一经过记录资源的本地受控转发，避免字体的跨域读取限制；SVG 的本地 fragment 引用不再被安全清理误删。
- 对浏览器可渲染但捕获管线仍无法读取的 stylesheet，保存为独立的只读外链清单；B 预览可加载该清单以补全渲染，但 Agent 不会把它当作可观察的规则来源。
- 样式表以原页面顺序保存；B 逐张加载已保存规则或对应外链，避免把所有可读规则合并后再追加外链造成级联顺序变化。
- 有 B 能力的工作区默认打开 B；管理页保留“查看 A 基线”。导出和导入会携带 B 覆盖层、资源清单和样式表顺序清单。
- 样式表的 `media` 与禁用状态会随清单保留；已捕获 CSS 中的 `@import` 保留其媒体条件并转为绝对 URL，作为样式表依赖直接加载，避免其内部的相对图片、字体和二级导入失去原始基准 URL。经本地资源路由加载失败的图片/字体会在副本管理页显示本次服务运行中仍未恢复的失败数。
- B 不再额外注入固定视口或框架 CSS，避免响应式页面产生人为横向溢出。
- 对“唯一嵌套 li 且外层无实质内容”的无效列表结构，在序列化前通用地归一化。浏览器解析静态 HTML 会自动拆开嵌套 li；若不归一化会多出空 flex 子项，改变间距。该规则不依赖网站、class、文案或 sourceId。

仍未通过自动视觉验收：本轮没有由 Agent 打开预览；以上结论来自用户的真实页面对照。哔哩哔哩的嵌套列表修复需要重新捕获后再由用户确认，不能把代码变更当成视觉通过。

管理页会标记“外链样式 N（依赖原站）”，统计已知的只读外链及直接 `@import` 目标，按 URL 去重。这些外部文件的内容没有完整保存在副本中，计数不代表加载成功，也不包含尚未读取的递归依赖。经工作区本地资源路由的失败会显示为“本次资源失败 N”，不涵盖浏览器直连外链；成功重试会自动清除对应计数，服务重启后重新开始统计。

旧副本缺少 `author-sheets.json` 时，从实际用于预览的 `author.css` 提取导入来源，生成 CSP 允许来源和外链诊断；有清单时以逐张加载的样式表为准。外链导入的其他域名依赖仍可能被 CSP 阻止，远程字体仍受原站 CORS 限制。本次修复没有递归下载外部 CSS，也不宣称支持完整离线资源封装。

## 2. 已确认的核心问题

### 2.1 冻结计算样式造成副本膨胀

`apps/extension/src/content/snapshot-capture.ts` 会遍历 `getComputedStyle()`，将大量计算属性展开为 `ui-snapshot-style-*` 规则。

一个真实副本样本约为：

- 总体积约 6 MB；
- CSS 约 5 MB；
- CSS 约 541 条规则；
- 约 25 万个声明；
- 平均每条规则约 1 万字符。

问题不只是存储大，还包括：

- 原始共享规则、变量、响应式条件和布局意图被固化；
- 模型需要从最终计算结果反推布局意图；
- 复杂结构修改需要重建父子和兄弟布局约束。

### 2.2 Agent 缺少修改后的真实视觉反馈

当前 `inspectElement` 返回的矩形主要来自捕获时保存的 `capturedRect`，不是修改后的实时浏览器几何。

当前 `validate_workspace` 主要校验：

- HTML/CSS 语法；
- 安全规则；
- 有限静态裁切规则。

它不能可靠判断修改后的 flex/grid 重排、文字换行、遮挡、溢出和真实视觉一致性。

### 2.3 澄清状态之前没有成为硬暂停

真实日志显示：模型已经调用 `clarify`，但后续仍继续读取、修改并最终提交。

这说明不能只依靠提示词要求模型等待，适配器和工具层必须强制执行状态边界。

### 2.4 B 路线最初不是独立候选（历史问题）

最初的 B 是：

```text
冻结 DOM + snapshot.css + author.css
```

所以 A/B 样式一模一样，没有实验区分度。

后来已改成：

```text
冻结 DOM + 基础页面框架样式 + author.css
```

B 当时会暴露原始 CSS 缺失问题；该结论已被 1.1 的后续实现和用户实测更新覆盖。

## 3. 已完成代码改动

### 3.1 澄清硬暂停

文件：

```text
packages/agent-runtime/src/adapters/cline-coding-agent-adapter.ts
```

已增加 `clarificationRequested` 状态：

- 调用 `clarify` 后当前执行段进入等待状态；
- 后续读取、修改和提交会被拒绝；
- 不依赖底层 Cline runtime 是否正确处理 `completesRun`。

用户要求暂时不写单测、不跑测试，因此后续不要新增或执行测试。

### 3.2 快照诊断

文件：

```text
apps/agent-service/src/workspace/snapshot-diagnostics.ts
```

可以统计：

- HTML/CSS/Outline/SourceMap 体积；
- CSS 占比；
- CSS 规则数和声明数；
- `ui-snapshot-style-*` 规则数量和体积；
- CSS 自定义属性数量；
- 内嵌图片/字体资源体积；
- author CSS 体积。

接口：

```text
GET /v1/workspaces/:workspaceId/diagnostics
```

### 3.3 author CSS 采集

文件：

```text
apps/extension/src/content/author-style-capture.ts
apps/extension/src/content/snapshot-capture.ts
packages/contracts/src/index.ts
```

已支持：

- 读取可访问 CSSOM；
- 收集 `<link rel="stylesheet">` URL；
- 记录可读和不可读 stylesheet；
- 记录缺失来源；
- 保存 `authorStyles` 和 `authorStyleSources`。

已过滤：

- `@import`；
- 外部 `url()`；
- `expression`；
- `behavior`；
- `-moz-binding`。

### 3.4 后台页面上下文抓取

文件：

```text
apps/extension/entrypoints/background.ts
```

后台会通过 `browser.scripting.executeScript` 在原页面上下文中 fetch stylesheet，尝试绕过内容脚本 CSSOM 的跨域读取限制。

获取失败会记录 URL 和错误，不静默伪装成完整 CSS。

### 3.5 B 候选保存与预览

工作区创建时保存：

```text
author.css
```

B 预览：

```text
/workspaces/:workspaceId/preview?candidate=B
```

A 预览：

```text
/workspaces/:workspaceId/preview
```

预览响应头：

```text
X-UI-Agent-Candidate: A | B
X-UI-Agent-Candidate-Label: frozen-computed-style | author-rules-overlay
```

管理页新增：

- 副本大小；
- CSS 占比；
- 冻结样式展开占比；
- 原始规则体积；
- “原始规则候选”按钮。

## 4. 当前真实验证结论（历史记录，已被 1.1 覆盖）

A 页面样式正常，B 页面严重失真：

- 页面退化为默认文本；
- Logo、导航、卡片布局等主要样式丢失；
- 只剩少量文本和图形。

原因基本确认：当前页面主要样式来自内容脚本无法通过 CSSOM 读取的外部 stylesheet、动态样式或运行时资源。

Ctrl+S 可以工作，是因为浏览器本身可以直接保存已加载的 CSS、图片、字体和其他资源，并重写本地路径；这不等于内容脚本可以读取 `cssRules`。

此处是资源转发实现前的结果，不能再作为 B 当前状态的判断依据。

## 5. 当前架构方向

保存、观察、修改三种表示分离：

```text
保存表示：页面及资源包，供恢复和渲染
观察表示：当前任务需要的结构、样式、几何和截图事实
修改表示：受控、可回滚的局部 ChangeSet
```

不再让一个巨大 HTML/CSS 文件同时承担保存、模型理解和编辑职责。

候选路线：

| 路线 | 说明 | 当前角色 |
| --- | --- | --- |
| A | 冻结计算样式 | 当前兼容基线 |
| B | 原始规则 + 局部覆盖 | 当前正在改造的候选 |
| C | 目标区域局部重建 | 后续挑战者 |
| D | 面向需求示意的视觉原型重建 | 产品范围扩大时再评估 |

## 6. 下一步必须连续完成的工作

### 6.1 资源转发与本地链接模式

已完成实现：

1. CSS `url(...)` 相对路径基于其 stylesheet URL 解析并转为绝对 URL；
2. author CSS 保留原有条件规则嵌套，危险 URL 仅在当前位置被中和，不再删除整条规则；
3. 每个图片、字体或其他资源记录 URL、stylesheet 来源和类型；
4. B 的图片、字体等记录资源由当前工作区的受控 assets 路由提供，避免浏览器直接跨域读取字体；
5. B 预览 CSP 仅允许自身、data 和 blob 资源；
6. 后台只重抓 CSSOM 明确报告为不可读的 stylesheet，避免与已读取规则重复拼接，并使用 `same-origin` 凭证策略。

仍需真实浏览器验证：资源重定向、资源清单上限、失败报告与缓存策略。

### 6.1.1 B 的可编辑覆盖层

已将 B 编辑链路切换为：

```text
index.html                 可编辑结构
author.css                 捕获原始规则，只读
author-overrides.css       可编辑、随 Revision 保存的局部视觉覆盖
snapshot.css               A 的冻结兼容基线与捕获布局事实，只读于 B 模式
```

这样视觉修改不会再写入或覆盖 A 的冻结规则。撤销、重做和 Revision 会同时保存 `author-overrides.css`；B 预览按 `author.css → 可渲染但不可读的外链 stylesheet → author-overrides.css` 的级联顺序加载。原始规则模式的静态校验只能验证结构与安全，仍需要真实浏览器几何闭环后才可宣称布局正确。

外链是渲染兼容能力，不保证可离线复现；链接失效、重定向、字体跨域或外链 CSS 内未知资源失败时必须报告为资源缺口，不能标为“已完整保存”。

### 6.2 修复 Windows 扩展构建

现有 `build:extension` 使用 Unix 风格环境变量：

```text
WXT_PUBLIC_AGENT_SERVICE_URL=... wxt build
```

PowerShell 会报：

```text
'WXT_PUBLIC_AGENT_SERVICE_URL' is not recognized
```

已改为 Node 启动脚本设置环境变量，再调用 WXT；仍需在 Windows 实际执行构建确认产物。

### 6.3 重新验证 B

资源和构建修复后：

1. 重启 Agent Service；
2. 重新构建并加载插件；
3. 重新创建副本；
4. 分别打开 A/B；
5. 查看响应头和截图；
6. 对比原页面、A、B 的初始渲染。

旧副本没有 `author.css`，不能用于 B 验证。

### 6.4 真实渲染观察接口

B 获取质量稳定后，再实现：

- 当前候选版本实际渲染；
- 目标区域和受影响区域实时矩形；
- 滚动尺寸和裁切链；
- 截图或局部截图；
- 真实浏览器验证后才允许提交 Revision。

## 7. 重要约束

- 不要再针对截图中的页面、文案、class 或固定布局写特例。
- 不要把“B 能打开”当作“B 还原成功”。
- 不要把 CSS 变小直接等同于 Agent 变快。
- 不要再新增单测或执行测试，除非用户重新授权。
- 普通代码、文档和静态检查可以连续完成，不要每个小功能停下来。
- 只有需要用户安装/重载插件、打开浏览器、提供真实页面或确认产品取舍时才暂停。

## 8. 当前工作树主要文件

```text
apps/agent-service/src/app.ts
apps/agent-service/src/workspace/store.ts
apps/agent-service/src/workspace/snapshot-diagnostics.ts
apps/extension/entrypoints/background.ts
apps/extension/src/content/author-style-capture.ts
apps/extension/src/content/snapshot-capture.ts
apps/extension/src/workspaces/WorkspaceManagerApp.tsx
packages/contracts/src/index.ts
packages/agent-runtime/src/adapters/cline-coding-agent-adapter.ts
docs/UIAgent_核心能力重设计与验证计划.md
docs/UIAgent_G1页面获取对照实验协议.md
docs/UIAgent_阶段进展与后续工作交接.md
```
