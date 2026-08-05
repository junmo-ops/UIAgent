import { serve } from '@hono/node-server';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '127.0.0.1';
serve({ fetch: createApp().fetch, port, hostname }, info => {
  const displayHost = hostname === '0.0.0.0' ? 'localhost' : hostname;
  console.log(`[agent-service] http://${displayHost}:${info.port} (${process.env.MODEL_MODE ?? 'mock'})`);
  console.log(`[agent-service] logs: http://${displayHost}:${info.port}/logs`);
});
