import { zValidator } from '@hono/zod-validator';
import { createAgentRuntime, plannerFromEnvironment } from '@ui-agent/agent-runtime';
import { executionSubmissionSchema, startTurnRequestSchema } from '@ui-agent/contracts';
import { UiChangeAgent } from '@ui-agent/ui-change-agent';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logPageHtml } from './log-page';
import { TurnLogStore } from './log-store';

export function createApp(env: NodeJS.ProcessEnv = process.env, providedLogStore?: TurnLogStore) {
  const logStore = providedLogStore ?? new TurnLogStore({
    filePath: env.LOG_FILE ?? '.logs/agent-turns.jsonl',
    model: {
      mode: env.MODEL_MODE ?? 'mock',
      provider: env.MODEL_PROVIDER ?? (env.MODEL_MODE === 'remote' ? 'openai-compatible' : 'mock'),
      name: env.MODEL_NAME
    }
  });
  const runtime = createAgentRuntime(plannerFromEnvironment(env, logStore.observe), logStore.observe);
  const agent = new UiChangeAgent(runtime);
  return new Hono()
    .use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'traceparent'] }))
    .get('/logs', c => c.html(logPageHtml))
    .get('/v1/logs', c => c.json(logStore.list()))
    .get('/v1/logs/:id', c => {
      const entry = logStore.get(c.req.param('id'));
      return entry ? c.json(entry, 200) : c.json({ code: 'LOG_NOT_FOUND', message: '日志不存在或已被轮转' }, 404);
    })
    .get('/health', c => c.json({
      ok: true,
      modelMode: env.MODEL_MODE ?? 'mock',
      ...(env.MODEL_MODE === 'remote' && {
        modelProvider: env.MODEL_PROVIDER ?? 'openai-compatible',
        modelName: env.MODEL_NAME
      })
    }))
    .post('/v1/turns', zValidator('json', startTurnRequestSchema), async c => {
      const request = c.req.valid('json');
      try {
        const result = await agent.start(request);
        return c.json(result, 200);
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        return c.json({ code: 'AGENT_ERROR', message, traceId: request.traceId }, 500);
      }
    })
    .post('/v1/turns/:turnId/execution', zValidator('json', executionSubmissionSchema), async c => {
      const submission = c.req.valid('json');
      if (c.req.param('turnId') !== submission.turnId) {
        return c.json({ code: 'TURN_MISMATCH', message: 'URL 中的 turnId 与请求体不一致', traceId: submission.traceId }, 400);
      }
      try {
        const result = await agent.resume(submission);
        logStore.recordExecution(submission, result);
        return c.json(result, 200);
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        return c.json({ code: 'AGENT_EXECUTION_ERROR', message, traceId: submission.traceId }, 500);
      }
    });
}

export type AgentApp = ReturnType<typeof createApp>;
