import { describe, expect, it } from 'vitest';
import type { AssistantStreamEvent } from '@ui-agent/contracts';
import { readAssistantEventStream } from './assistant-event-stream';

describe('readAssistantEventStream', () => {
  it('parses SSE events split across arbitrary transport chunks', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"type":"answer_',
      'delta","text":"你',
      '好"}\r\n\r\ndata: {"type":"result","result":{"kind":"answered",',
      '"answer":"你好"}}\n\n'
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    });
    const events: AssistantStreamEvent[] = [];

    await readAssistantEventStream(new Response(body), event => { events.push(event); });

    expect(events).toEqual([
      { type: 'answer_delta', text: '你好' },
      { type: 'result', result: { kind: 'answered', answer: '你好' } }
    ]);
  });
});
