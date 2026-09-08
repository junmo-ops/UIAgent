// UIAgent maintained runtime. API provenance: see UPSTREAM_NOTICE.md.
import { randomUUID } from 'node:crypto';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { jsonSchema, streamText, stepCountIs } from 'ai';

const asError = value => value instanceof Error ? value : new Error(String(value));
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
    const diagnostics = { version: 1, runtimeRevision: '2026-09-08-lifecycle-log-v1',
      countingBasis: 'streamText invocations; SDK internal network retries are not counted',
      maxIterations: this.config.maxIterations ?? 12, requiredCompletionTool: this.config.completionPolicy?.requireCompletionTool === true,
      calls: [], continuationCount: 0 };
    let currentCall;
    const errorInfo = error => {
      const value = asError(error);
      // Deliberately exclude provider response bodies, request headers and URLs.
      return { name: value.name, ...(Number.isInteger(value.statusCode) ? { statusCode: value.statusCode } : {}) };
    };
    const required = this.config.completionPolicy?.requireCompletionTool === true;
    // Serialize tool execution; successful completion prevents later mutations.
    let queue = Promise.resolve();
    const tools = Object.fromEntries((this.config.tools ?? []).map(tool => [tool.name, {
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
              toolCallId: call?.toolCallId, signal: controller.signal, metadata: this.config.toolContextMetadata });
            if (tool.lifecycle?.completesRun) { completed = true; completionOutput = value; }
            toolLog.status = 'succeeded';
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
        currentCall = { modelCall: iterations, startedAt: new Date(callStarted).toISOString(),
          status: 'running', inputMessageCount: messages.length, outputTextChars: 0, tools: [] };
        diagnostics.calls.push(currentCall);
        let calls = 0, text = '';
        const stream = streamText({ model: provider.chatModel(this.config.modelId),
          system: this.config.systemPrompt, messages, tools, stopWhen: stepCountIs(1), abortSignal: controller.signal });
        for await (const event of stream.fullStream) {
          if (currentCall.firstOutputMs === undefined && ['text-delta', 'reasoning-delta', 'tool-call'].includes(event.type)) {
            currentCall.firstOutputMs = Date.now() - callStarted;
          }
          if (event.type === 'error') throw asError(event.error);
          if (event.type === 'abort') throw new Error('Model stream aborted');
          if (event.type === 'text-delta') {
            const delta = event.text ?? event.textDelta ?? '';
            text += delta; outputText += delta;
            currentCall.outputTextChars += delta.length;
            this.emit({ type: 'assistant-text-delta', iteration: iterations, text: delta, accumulatedText: outputText });
          }
          if (event.type === 'tool-call') { calls++; this.emit({ type: 'tool-started', iteration: iterations, toolCall: event }); }
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
        for (const [key, value] of Object.entries(stepUsage ?? {})) if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
        if (controller.signal.aborted) throw new Error('Run aborted');
        if (completed) {
          if (!outputText && typeof completionOutput === 'string') outputText = completionOutput;
          break;
        }
        if (['error', 'content-filter', 'length'].includes(finishReason)) throw new Error('Model stopped: ' + finishReason);
        if (!calls) {
          if (!required) {
            if (!text.trim()) throw new Error('Model returned no text or tool calls (finishReason=' + finishReason + ')');
            completed = true; break;
          }
          if (++emptyContinuations > 2) throw new Error('Agent stopped without successful completion tool (finishReason=' + finishReason + (lastToolError ? '; lastToolError=' + lastToolError : '') + ')');
          messages.push({ role: 'user', content: '任务尚未成功提交。请结合以上原始需求、工具结果和错误继续完成剩余工作。不要假设已修改或已验证；完成必要校验后调用完成工具，存在需求歧义时调用澄清工具。' });
          currentCall.continuationReason = text.trim() ? 'text_without_completion' : 'empty_response';
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
      }
      const final = result(this.externallyAborted ? 'aborted' : 'failed', asError(error));
      this.emit({ type: 'run-failed', error: final.error, result: final }); return final;
    } finally { if (this.controller === controller) this.controller = undefined; }
  }
}
