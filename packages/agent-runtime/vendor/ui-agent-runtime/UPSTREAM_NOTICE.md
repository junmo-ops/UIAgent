# Upstream notice

This directory contains UIAgent's DeepSeek-compatible Agent Runtime. Its public
`Agent`/`createTool` contract follows the subset of the Cline SDK Agent API
consumed by UIAgent; it does not include Cline Core, MCP, telemetry, or other
model providers.

- Upstream project: [cline/cline](https://github.com/cline/cline)
- API reference: `sdk/packages/agents/src/index.ts`
- Upstream package version: `0.0.75`
- Upstream source commit: `d50be161e4e7a9d4f90ec3be13bc85bb90535c25`
- License: Apache-2.0

The maintained `index.js` uses `ai` and `@ai-sdk/openai-compatible` at runtime
to call a DeepSeek-compatible endpoint. UIAgent does not publish this directory
as a standalone package.

2026-09-08: UIAgent replaced the compact implementation with a readable,
bounded model-step loop. Continuations retain response messages and tool
results within a run. Completion tools, sequential tool execution, stream
errors, cancellation, and model-request counts are handled explicitly.
This is a local implementation change, not an upstream Cline SDK update.

2026-09-08: Provider failures now retain only bounded, sanitized error fields,
an allowlisted request identifier and an allowlisted response summary. Request
bodies, URLs, credentials and arbitrary response headers remain excluded.

2026-09-08: The local runtime now records the per-call available-tool set so
long runs can be diagnosed. UIAgent's adapter caps batch inspection and
style-symbol results. These are local orchestration and context-budget changes,
not an upstream Cline SDK update.

2026-09-09: Per-call model output is bounded by a configurable token limit.
Invalid tool calls and tool errors are recorded explicitly, while raw reasoning
remains available in final server diagnostics instead of being sent repeatedly
through the progress API. The adapter also supplies compact selected-element
context with the initial request and uses a shorter planning/completion
protocol to reduce model round trips.

2026-09-09: Gateway output quota rejection (HTTP 433 with LAILGW0433) is
retried before any streamed output or tool execution. The run retains prior
messages and edits, allows cancellation during waits, and permits at most
ten consecutive retries at ten-second intervals, respecting longer Retry-After
values. A completed model request resets the retry counter. Retries are recorded separately from
model decision rounds. This is a local runtime change.

2026-09-10: A model response that exhausts its output-token limit without
executing a tool receives one concise action-only recovery prompt. A second
such response stops the run instead of repeatedly consuming long model rounds.
This is a local runtime change.

2026-09-10: Adapter tool errors explicitly marked terminal now stop the run
after the current streamed tool result is drained. This makes the existing
identical-error retry ceiling effective and prevents repeated failed strategies
from consuming the remaining model-iteration budget.
