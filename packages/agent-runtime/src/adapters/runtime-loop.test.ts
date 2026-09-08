import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('ai', () => ({ streamText: mocks.stream, jsonSchema: (x: unknown) => x, stepCountIs: () => () => true }));
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: () => ({ chatModel: () => ({}) }) }));
import { Agent, createTool } from '../../vendor/ui-agent-runtime/index.js';

function step(events: unknown[], messages: unknown[] = []) {
  return { fullStream: (async function* () { yield* events; })(),
    responseMessages: Promise.resolve(messages), finishReason: Promise.resolve('stop'), usage: Promise.resolve({}) };
}
function agent(tools: any[] = [], maxIterations = 8, required = true) {
  return new Agent({ providerId: 'deepseek', modelId: 'test', baseUrl: 'https://example.invalid',
    tools, maxIterations, completionPolicy: { requireCompletionTool: required } });
}
const finish = (execute = async () => 'done') => createTool({
  name: 'finish', description: 'finish', inputSchema: {}, lifecycle: { completesRun: true }, execute
});
beforeEach(() => mocks.stream.mockReset());

describe('runtime task lifecycle', () => {
  it('reports stream error instead of completed even without a tool call', async () => {
    mocks.stream.mockImplementation(() => step([{ type: 'error', error: new Error('provider unavailable') }]));
    const result = await agent().run('edit');
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('provider unavailable');
    expect(result.diagnostics?.calls[0]).toMatchObject({ modelCall: 1, status: 'failed', outputTextChars: 0, tools: [], error: { name: 'Error' } });
    expect(result.diagnostics?.calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });
  it('records bounded provider error details without credentials or arbitrary headers', async () => {
    const error = Object.assign(new Error(''), {
      name: 'AI_APICallError', statusCode: 433, code: 'provider_rejected',
      responseHeaders: { 'x-request-id': 'request-123', authorization: 'Bearer should-not-leak' },
      responseBody: JSON.stringify({ error: { code: 'invalid_request', message: 'token=super-secret invalid input' }, debug: 'hidden' }),
      requestBodyValues: { apiKey: 'should-not-leak' }
    });
    mocks.stream.mockImplementation(() => step([{ type: 'error', error }]));
    const result = await agent().run('edit');
    expect(result.diagnostics?.error).toMatchObject({
      name: 'AI_APICallError', statusCode: 433, code: 'provider_rejected', requestId: 'request-123'
    });
    const serialized = JSON.stringify(result.diagnostics);
    expect(serialized).toContain('invalid_request');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('should-not-leak');
    expect(serialized).not.toContain('authorization');
  });
  it('retains original request and tool history when resuming after plain text', async () => {
    const history = { role: 'assistant', content: 'still working' };
    mocks.stream.mockImplementationOnce(() => step([{ type: 'text-delta', text: 'still working' }], [history]));
    mocks.stream.mockImplementationOnce((options: any) => {
      expect(options.messages).toContainEqual({ role: 'user', content: 'original requirement' });
      expect(options.messages).toContainEqual(history);
      return { ...step([]), fullStream: (async function* () {
        yield { type: 'tool-call' };
        await options.tools.finish.execute({});
      })() };
    });
    const result = await agent([finish()]).run('original requirement');
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(2);
    expect(result.diagnostics?.continuationCount).toBe(1);
    expect(result.diagnostics?.calls[0]?.continuationReason).toBe('text_without_completion');
    expect(result.diagnostics?.completionTool).toBe('finish');
  });
  it('reevaluates phased tool availability before every model call', async () => {
    let declared = false;
    const declare = createTool({
      name: 'declare', description: '', inputSchema: {}, execute: () => { declared = true; return 'declared'; }
    });
    const guarded = createTool({
      name: 'guarded_finish', description: '', inputSchema: {}, isAvailable: () => declared,
      lifecycle: { completesRun: true }, execute: () => 'done'
    });
    mocks.stream.mockImplementationOnce((options: any) => {
      expect(Object.keys(options.tools)).toEqual(['declare']);
      return { ...step([]), fullStream: (async function* () {
        yield { type: 'tool-call' };
        await options.tools.declare.execute({});
      })() };
    });
    mocks.stream.mockImplementationOnce((options: any) => {
      expect(Object.keys(options.tools)).toEqual(['declare', 'guarded_finish']);
      return { ...step([]), fullStream: (async function* () {
        yield { type: 'tool-call' };
        await options.tools.guarded_finish.execute({});
      })() };
    });
    const result = await agent([declare, guarded]).run('edit');
    expect(result.status).toBe('completed');
    expect(result.diagnostics?.calls.map(call => call.availableTools)).toEqual([
      ['declare'], ['declare', 'guarded_finish']
    ]);
  });
  it('does not complete on a rejected finish and preserves its error for continuation', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('missing panel')).mockResolvedValueOnce('done');
    mocks.stream.mockImplementation((options: any) => ({ ...step([]),
      fullStream: (async function* () { yield { type: 'tool-call' }; await options.tools.finish.execute({}); })()
    }));
    const run = await agent([finish(execute)]).run('edit');
    expect(run.status).toBe('completed');
    expect(run.diagnostics?.calls.map(call => call.tools[0]?.status)).toEqual(['failed', 'succeeded']);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('counts model requests, serializes tools and prevents mutation after completion', async () => {
    const mutation = vi.fn();
    const contexts: number[] = [];
    mocks.stream.mockImplementation((options: any) => ({ ...step([]),
      fullStream: (async function* () {
        yield { type: 'tool-call' }; yield { type: 'tool-call' };
        await Promise.all([options.tools.finish.execute({}), options.tools.change.execute({})]);
      })()
    }));
    const done = finish(async () => 'done');
    const original = done.execute;
    done.execute = (input, context) => { contexts.push(context.iteration); return original(input, context); };
    const result = await agent([done, createTool({ name: 'change', description: '', inputSchema: {}, execute: mutation })]).run('edit');
    expect(result.iterations).toBe(1);
    expect(contexts).toEqual([1]);
    expect(mutation).not.toHaveBeenCalled();
  });
  it('bounds empty responses and does not invent a completed task', async () => {
    mocks.stream.mockImplementation(() => step([]));
    const result = await agent().run('edit');
    expect(result.status).toBe('failed');
    expect(result.iterations).toBe(3);
    expect(result.error?.message).toContain('without successful completion');
  });
  it('allows normal chat text without a completion tool', async () => {
    mocks.stream.mockImplementation(() => step([{ type: 'text-delta', text: 'hello' }]));
    expect((await agent([], 8, false).run('hello')).outputText).toBe('hello');
  });
});
