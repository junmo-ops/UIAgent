import { serve } from '@hono/node-server';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp().fetch, port, hostname: '127.0.0.1' }, info => {
  console.log(`[agent-service] http://127.0.0.1:${info.port} (${process.env.MODEL_MODE ?? 'mock'})`);
  console.log(`[agent-service] logs: http://127.0.0.1:${info.port}/logs`);
});
