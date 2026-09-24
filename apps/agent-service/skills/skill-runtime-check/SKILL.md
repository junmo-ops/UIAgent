---
name: skill-runtime-check
description: 实际调用 Python 生成执行报告，用于验证技能加载、脚本执行和产物回传链路。
---

# 技能运行验证

说明正在使用技能运行验证。不读取、不修改当前页面，也不需要用户选中页面元素。

1. 提取用户明确提供的验证文本；没有指定时使用“你好，UIAgent”。
2. 必须调用 `run_skill_script`，不能自行计算或编造结果，也不要用其他脚本替代 Python：

```json
{
  "script": "scripts/report.py",
  "args": {"text": "你好，UIAgent"},
  "inputs": []
}
```

3. 只有 `exitCode=0`、没有 `stopped` 且产物中包含 `execution-report.json` 时，才说明本次脚本执行和文本产物回传成功。
4. 从产物正文中原样展示以下字段：`execution_id`、`executed_at_utc`、`python_version`、`input_text`、`character_count`、`utf8_bytes`、`sha256`。字数按 Unicode 码点计算，包含空白和标点，不代表用户感知的字形数量。
5. 提醒用户可再次运行：同一文本的字数、字节数和哈希应相同，随机执行 ID 应不同；可核对服务端 `[skill-script]` 日志中的技能 ID、脚本路径和退出码。

若 Python 不可用、工具失败、超时或缺少产物，如实说明失败原因，不输出模拟报告，不宣称链路通过。不要返回服务器临时路径或虚构下载链接。
