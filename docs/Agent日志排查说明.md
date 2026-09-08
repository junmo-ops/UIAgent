# Agent 日志排查说明

日志详情中的“运行诊断”“提交与回滚”和“源码工具循环”用于一起还原任务过程。复制当前日志会包含这些字段。新字段仅出现在更新服务后的新任务中，旧日志仍可查看。

## 运行诊断

位置：`codingAgent.checkpoint.runtime`。

- `runtimeRevision`：运行时实现标识，帮助确认部署版本。
- `maxIterations`、`requiredCompletionTool`：本次运行的有效轮数上限和完成约束。
- `calls`：每次调用 streamText 的记录；SDK 内部网络重试不单独计数，不能等同于实际 HTTP 请求次数。
- `startedAt`、`durationMs`：每轮开始时间及总耗时。总耗时包含流消费和工具执行，不能直接当作纯模型推理耗时。
- `firstOutputMs`：到首个文本、推理片段或工具调用事件的等待时间；没有有效输出时不提供这个字段。
- `finishReason`：模型返回的结束原因。流异常发生在结束原因返回前时，该字段可能缺失。
- `outputTextChars`：普通文本输出字符数；不保存完整模型正文或推理内容。
- `tools`：工具名称、调用 ID、执行状态和耗时。运行时成功执行工具不代表业务校验通过，具体拦截信息需查看源码工具循环。
- `usage`：SDK 提供的数值型用量。未返回的指标不补零。
- `continuationReason`、`continuationCount`：因只返回文字或空响应而继续执行的原因与次数；正常工具循环不计入该次数。
- `error`：错误类型及可用的 HTTP 状态码；具体失败消息同时查看日志顶层 error/result 和源码工具步骤。诊断摘要不保存请求头、凭据或原始响应体。

## 提交与回滚

位置：`codingAgent.checkpoint.lifecycle`。

记录提交模式、是否声明意图、空间归属校验状态、finish 尝试次数，以及回滚是否成功。调用过 finish 不等于成功提交；以最终 result 和生命周期状态共同判断。

## 源码工具循环

每项新增时间戳、工具调用 ID、执行结果分类及返回文本截断信息。`outcome=blocked` 表示读取预算或重复读取被拦截；`failed` 表示工具报错。`resultChars` 是截断前长度，`resultTruncated` 表示该步骤在日志中只保留了前 16000 字符。

## 常见判断

- 无工具调用便失败：检查首轮 error、finishReason、outputTextChars 和续跑次数，区分接口异常、空响应及只返回文字。
- 等待较久：比较每轮 durationMs、firstOutputMs 和工具 durationMs，区分输出等待、工具执行及反复检索。
- 页面未保留修改：检查 finish 尝试对应的工具错误、最终 result 以及 rollback 状态。
- 修改后无法继续检查：检查源码工具步骤的 blocked 分类，以及修改前后查询参数和预算提示。

这些日志用于定位执行过程，不证明修改后的页面外观正确；视觉效果仍需浏览器验证。
