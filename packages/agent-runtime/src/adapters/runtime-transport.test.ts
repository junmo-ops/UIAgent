import { afterEach, expect, it, vi } from 'vitest';
import { Agent, createTool } from '../../vendor/ui-agent-runtime/index.js';
afterEach(() => vi.unstubAllGlobals());

it('retains actual AI SDK tool results across requests without a live model', async () => {
  const requests: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options: any) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const tool = requests.length === 1 ? 'inspect' : 'finish';
    const chunks = [
      { id: 'response', object: 'chat.completion.chunk', created: 1, model: 'test',
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
          { index: 0, id: 'call-' + tool, type: 'function', function: { name: tool, arguments: '{}' } }
        ] }, finish_reason: null }] },
      { id: 'response', object: 'chat.completion.chunk', created: 1, model: 'test',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ];
    return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  }));
  const agent = new Agent({ providerId: 'deepseek', baseUrl: 'https://example.invalid/v1', modelId: 'test',
    completionPolicy: { requireCompletionTool: true }, tools: [
      createTool({ name: 'inspect', description: 'inspect', inputSchema: { type: 'object', properties: {} }, execute: () => 'observed structure' }),
      createTool({ name: 'finish', description: 'finish', inputSchema: { type: 'object', properties: {} },
        lifecycle: { completesRun: true }, execute: () => 'done' })
    ] });
  const result = await agent.run('original request');
  expect(result.error).toBeUndefined();
  expect(result.status).toBe('completed');
  expect(result.iterations).toBe(2);
  expect(requests[1].messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'user', content: 'original request' }),
    expect.objectContaining({ role: 'tool', content: 'observed structure' })
  ]));
});
