// UIAgent maintained runtime. API provenance: see UPSTREAM_NOTICE.md.
import { randomUUID } from 'node:crypto';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { jsonSchema, streamText, stepCountIs } from 'ai';

const asError = value => value instanceof Error ? value : new Error(String(value));
const sanitizeDiagnosticText = value => String(value ?? '')
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  .replace(/((?:api[-_]?key|token|authorization|secret)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]')
  .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g, '[REDACTED_TOKEN]')
  .replace(/\s+/g, ' ').trim().slice(0, 600);
const diagnosticResponseSummary = body => {
  if (typeof body !== 'string' || !body.trim()) return undefined;
  try {
    const parsed = JSON.parse(body);
    const source = parsed?.error ?? parsed;
    if (typeof source === 'string') return sanitizeDiagnosticText(source);
    if (source && typeof source === 'object') {
      const selected = {};
      for (const key of ['code', 'type', 'message', 'msg', 'request_id', 'requestId']) {
        if (['string', 'number'].includes(typeof source[key])) selected[key] = sanitizeDiagnosticText(source[key]);
      }
      if (Object.keys(selected).length) return JSON.stringify(selected);
    }
  } catch { /* Non-JSON responses are summarized below. */ }
  return sanitizeDiagnosticText(body.replace(/<[^>]+>/g, ' '));
};
const diagnosticRequestId = headers => {
  if (!headers) return undefined;
  const get = name => typeof headers.get === 'function' ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  for (const name of ['x-request-id', 'request-id', 'x-trace-id', 'trace-id']) {
    const value = get(name);
    if (value) return sanitizeDiagnosticText(value);
  }
};
export function createTool(config) {
  if (!/^[a-z][a-z0-9_]*$/.test(config.name)) throw new Error('Invalid tool name: ' + config.name);
  return { ...config, timeoutMs: config.timeoutMs ?? 30000, retryable: config.retryable ?? true, maxRetries: config.maxRetries ?? 3 };
}

export class Agent {
  constructor(config) {
    if (!['openai-compatible', 'deepseek'].includes(config.providerId)) throw new Error('Unsupported provider');
    if (!config.modelId || !config.baseUrl) throw new Error('modelId and baseUrl are required');
    this.config = config;
    this.listeners = new Set();
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  abort(reason) { this.externallyAborted = true; this.controller?.abort(reason); }

  async run(input) {
    const agentId = randomUUID(), runId = randomUUID();
    const controller = new AbortController();
    this.controller = controller;
    this.externallyAborted = false;
    const messages = [{ role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) }];
    let iterations = 0, outputText = '', finishReason, lastToolError, completed = false, completionOutput;
    let emptyContinuations = 0;
    const usage = {};
    const runtimeStarted = Date.now();
    const diagnostics = { version: 1, runtimeRevision: '2026-09-09-performance-v8',
      countingBasis: 'streamText invocations; SDK internal network retries are not counted',
      maxIterations: this.config.maxIterations ?? 12, maxOutputTokens: this.config.maxOutputTokens,
      requiredCompletionTool: this.config.completionPolicy?.requireCompletionTool === true,
      calls: [], continuationCount: 0 };
    let currentCall;
    const errorInfo = error => {
      const value = asError(error);
      const requestId = diagnosticRequestId(value.responseHeaders);
      const responseSummary = diagnosticResponseSummary(value.responseBody);
      const message = sanitizeDiagnosticText(value.message);
      // Only allowlisted, bounded response fields are retained. Request bodies,
      // URLs, credentials and arbitrary headers are deliberately excluded.
      return { name: value.name,
        ...(Number.isInteger(value.statusCode) ? { statusCode: value.statusCode } : {}),
        ...(typeof value.code === 'string' ? { code: sanitizeDiagnosticText(value.code) } : {}),
        ...(message ? { message } : {}), ...(requestId ? { requestId } : {}),
        ...(responseSummary ? { responseSummary } : {}) };
    };
    const required = this.config.completionPolicy?.requireCompletionTool === true;
    // Serialize tool execution; successful completion prevents later mutations.
    let queue = Promise.resolve();
    const runtimeTools = () => Object.fromEntries((this.config.tools ?? [])
      .filter(tool => tool.isAvailable?.({ iteration: iterations }) !== false)
      .map(tool => [tool.name, {
      description: tool.description,
      inputSchema: jsonSchema(tool.inputSchema),
      execute: (args, call) => {
        const task = queue.then(async () => {
          if (controller.signal.aborted) throw new Error('Run aborted');
          if (completed) return { error: 'Run already completed; no further tools allowed' };
          const toolStarted = Date.now();
          const toolLog = { name: tool.name, toolCallId: call?.toolCallId, status: 'running' };
          currentCall?.tools.push(toolLog);
          try {
            const value = await tool.execute(args, { agentId, runId, iteration: iterations,
              toolCallId: call?.toolCallId, signal: controller.signal, metadata: this.config.toolContextMetadata,
              emitUpdate: update => { if (update?.type === 'tool-outcome' && update.outcome === 'blocked') toolLog.status = 'blocked'; } });
            if (tool.lifecycle?.completesRun) { completed = true; completionOutput = value; }
            if (toolLog.status !== 'blocked') toolLog.status = 'succeeded';
            if (tool.lifecycle?.completesRun) diagnostics.completionTool = tool.name;
            return value;
          } catch (error) {
            toolLog.status = 'failed';
            toolLog.error = errorInfo(error);
            lastToolError = asError(error).message;
            return { error: lastToolError };
          } finally {
            toolLog.durationMs = Date.now() - toolStarted;
          }
        });
        queue = task.then(() => {}, () => {});
        return task;
      }
    }]));
    const result = (status, error) => ({ agentId, runId, status, iterations, outputText,
      messages, usage, finishReason, diagnostics: { ...diagnostics, durationMs: Date.now() - runtimeStarted,
        status, finishReason, ...(error ? { error: errorInfo(error) } : {}) }, ...(error ? { error } : {}) });
    try {
      const provider = createOpenAICompatible({ name: 'ui-agent-deepseek', apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl, headers: this.config.headers });
      this.emit({ type: 'run-started', iteration: 0 });
      while (iterations < (this.config.maxIterations ?? 12)) {
        if (controller.signal.aborted) throw new Error('Run aborted');
        iterations += 1;
        const callStarted = Date.now();
        const tools = runtimeTools();
        currentCall = { modelCall: iterations, startedAt: new Date(callStarted).toISOString(),
          status: 'running', inputMessageCount: messages.length, availableTools: Object.keys(tools), outputTextChars: 0, tools: [] };
        diagnostics.calls.push(currentCall);
        this.emit({ type: 'model-call-updated', call: { modelCall: iterations, startedAt: currentCall.startedAt, status: 'running' } });
        let reasoning = '', reasoningTruncated = false;
        let calls = 0, inputErrors = 0, text = '';
        const reportedToolErrorIds = new Set();
        const stream = streamText({ model: provider.chatModel(this.config.modelId),
          system: this.config.systemPrompt, messages, tools, maxOutputTokens: this.config.maxOutputTokens,
          stopWhen: stepCountIs(1), abortSignal: controller.signal });
        for await (const event of stream.fullStream) {
          if (currentCall.firstOutputMs === undefined && ['text-delta', 'reasoning-delta', 'tool-call'].includes(event.type)) {
            currentCall.firstOutputMs = Date.now() - callStarted;
          }
          if (event.type === 'error') throw asError(event.error);
          if (event.type === 'abort') throw new Error('Model stream aborted');
          if (event.type === 'reasoning-delta') {
            const delta = event.text ?? event.textDelta ?? '';
            reasoningTruncated ||= reasoning.length + delta.length > 12000;
            reasoning = (reasoning + delta).slice(0, 12000);
            currentCall.reasoning = reasoning;
            currentCall.reasoningTruncated = reasoningTruncated;
          }
          if (event.type === 'text-delta') {
            const delta = event.text ?? event.textDelta ?? '';
            text += delta; outputText += delta;
            currentCall.outputTextChars += delta.length;
            this.emit({ type: 'assistant-text-delta', iteration: iterations, text: delta, accumulatedText: outputText });
          }
          if (event.type === 'tool-call') {
            if (event.invalid) {
              inputErrors++;
              if (event.toolCallId) reportedToolErrorIds.add(event.toolCallId);
              const error = errorInfo(event.error ?? new Error('Invalid tool call'));
              lastToolError = error.message ?? 'Invalid tool call';
              (currentCall.toolInputErrors ??= []).push({
                ...(event.toolName ? { name: sanitizeDiagnosticText(event.toolName) } : {}),
                ...(event.toolCallId ? { toolCallId: sanitizeDiagnosticText(event.toolCallId) } : {}),
                ...(error.message ? { message: error.message } : {})
              });
              continue;
            }
            calls++;
            (currentCall.toolCalls ??= []).push({
              ...(event.toolName ? { name: sanitizeDiagnosticText(event.toolName) } : {}),
              ...(event.toolCallId ? { toolCallId: sanitizeDiagnosticText(event.toolCallId) } : {})
            });
            this.emit({ type: 'tool-started', iteration: iterations, toolCall: event });
          }
          if (event.type === 'tool-input-error') {
            if (!event.toolCallId || !reportedToolErrorIds.has(event.toolCallId)) {
              inputErrors++;
              if (event.toolCallId) reportedToolErrorIds.add(event.toolCallId);
              if (event.errorText) lastToolError = sanitizeDiagnosticText(event.errorText);
              (currentCall.toolInputErrors ??= []).push({
                ...(event.toolName ? { name: sanitizeDiagnosticText(event.toolName) } : {}),
                ...(event.toolCallId ? { toolCallId: sanitizeDiagnosticText(event.toolCallId) } : {}),
                ...(event.errorText ? { message: sanitizeDiagnosticText(event.errorText) } : {})
              });
            }
          }
          if (event.type === 'tool-error') {
            if (!event.toolCallId || !reportedToolErrorIds.has(event.toolCallId)) {
              inputErrors++;
              if (event.toolCallId) reportedToolErrorIds.add(event.toolCallId);
              const error = errorInfo(event.error);
              lastToolError = error.message ?? lastToolError;
              (currentCall.toolInputErrors ??= []).push({
                ...(event.toolName ? { name: sanitizeDiagnosticText(event.toolName) } : {}),
                ...(event.toolCallId ? { toolCallId: sanitizeDiagnosticText(event.toolCallId) } : {}),
                ...(error.message ? { message: error.message } : {})
              });
            }
            this.emit({ type: 'tool-finished', iteration: iterations, toolCall: event });
          }
          if (event.type === 'tool-result') this.emit({ type: 'tool-finished', iteration: iterations, toolCall: event });
        }
        await queue;
        finishReason = await stream.finishReason;
        currentCall.finishReason = finishReason;
        currentCall.durationMs = Date.now() - callStarted;
        currentCall.status = 'completed';
        messages.push(...await stream.responseMessages);
        const stepUsage = await stream.usage;
        currentCall.usage = Object.fromEntries(Object.entries(stepUsage ?? {}).filter(([, value]) => typeof value === 'number'));
        const reasoningTokens = stepUsage?.outputTokenDetails?.reasoningTokens ?? stepUsage?.outputTokensDetails?.reasoningTokens;
        const cachedInputTokens = stepUsage?.inputTokenDetails?.cacheReadTokens ?? stepUsage?.inputTokensDetails?.cacheReadTokens;
        if (typeof reasoningTokens === 'number') currentCall.usage.reasoningTokens = reasoningTokens;
        if (typeof cachedInputTokens === 'number') currentCall.usage.cachedInputTokens = cachedInputTokens;
        this.emit({ type: 'model-call-updated', call: { modelCall: iterations, startedAt: currentCall.startedAt,
          status: 'completed', durationMs: currentCall.durationMs, usage: currentCall.usage, tools: currentCall.tools } });
        for (const [key, value] of Object.entries(currentCall.usage)) usage[key] = (usage[key] ?? 0) + value;
        currentCall.toolCallCount = calls;
        currentCall.toolInputErrorCount = inputErrors;
        currentCall.blockedToolCallCount = currentCall.tools.filter(tool => tool.status === 'blocked').length;
        currentCall.executedToolCallCount = currentCall.tools.filter(tool => tool.status !== 'blocked').length;
        if (controller.signal.aborted) throw new Error('Run aborted');
        if (completed) {
          if (!outputText && typeof completionOutput === 'string') outputText = completionOutput;
          break;
        }
        if (['error', 'content-filter'].includes(finishReason)) throw new Error('Model stopped: ' + finishReason);
        if (!currentCall.executedToolCallCount) {
          const attemptedToolWithoutExecution = calls + inputErrors > 0;
          if (!required) {
            if (!attemptedToolWithoutExecution) {
              if (!text.trim()) throw new Error('Model returned no text or tool calls (finishReason=' + finishReason + ')');
              completed = true; break;
            }
          }
          if (++emptyContinuations > 2) throw new Error('Agent stopped without successful completion tool (finishReason=' + finishReason + (lastToolError ? '; lastToolError=' + lastToolError : '') + ')');
          messages.push({ role: 'user', content: attemptedToolWithoutExecution
            ? '刚才尝试调用工具但没有执行成功。请检查工具名称和参数是否符合当前可用工具的 schema；不要假设任何源码已修改。修正后继续执行，完成必要校验后调用完成工具；存在需求歧义时调用澄清工具。'
            : '任务尚未成功提交。请结合以上原始需求、工具结果和错误继续完成剩余工作。不要假设已修改或已验证；完成必要校验后调用完成工具，存在需求歧义时调用澄清工具。' });
          currentCall.continuationReason = attemptedToolWithoutExecution
            ? 'tool_call_not_executed'
            : text.trim() ? 'text_without_completion' : 'empty_response';
          diagnostics.continuationCount++;
        } else emptyContinuations = 0;
      }
      if (!completed) throw new Error('Agent exceeded maxIterations (' + (this.config.maxIterations ?? 12) + ') without completion' + (lastToolError ? '; lastToolError=' + lastToolError : ''));
      const final = result('completed'); this.emit({ type: 'run-finished', result: final }); return final;
    } catch (error) {
      // No tools may still be writing when the caller begins rollback.
      controller.abort(error);
      await queue;
      if (currentCall?.status === 'running') {
        currentCall.status = 'failed';
        currentCall.durationMs = Date.now() - Date.parse(currentCall.startedAt);
        currentCall.error = errorInfo(error);
        this.emit({ type: 'model-call-updated', call: { modelCall: iterations, startedAt: currentCall.startedAt,
          status: 'failed', durationMs: currentCall.durationMs, tools: currentCall.tools } });
      }
      const final = result(this.externallyAborted ? 'aborted' : 'failed', asError(error));
      this.emit({ type: 'run-failed', error: final.error, result: final }); return final;
    } finally { if (this.controller === controller) this.controller = undefined; }
  }
}
