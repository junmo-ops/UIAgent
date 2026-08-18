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

The generated `index.js` uses `ai` and `@ai-sdk/openai-compatible` at runtime
to call a DeepSeek-compatible endpoint. UIAgent does not publish this directory
as a standalone package.
