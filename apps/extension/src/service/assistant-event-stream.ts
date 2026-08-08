import {
  assistantStreamEventSchema,
  type AssistantStreamEvent
} from '@ui-agent/contracts';

export async function readAssistantEventStream(
  response: Response,
  onEvent: (event: AssistantStreamEvent) => void | Promise<void>
): Promise<void> {
  if (!response.body) throw new Error('智能助手没有返回可读取的数据流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = async (block: string) => {
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    await onEvent(assistantStreamEventSchema.parse(JSON.parse(data)));
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      await consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (buffer.trim()) await consume(buffer);
}
