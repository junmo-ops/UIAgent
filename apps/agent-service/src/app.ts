import { zValidator } from '@hono/zod-validator';
import {
  codingAgentPortFromEnvironment,
  createAgentRuntime,
  plannerFromEnvironment,
  type CodingAgentPort
} from '@ui-agent/agent-runtime';
import {
  executionSubmissionSchema,
  snapshotCreatedSchema,
  sourceTurnRequestSchema,
  sourceTurnProgressSchema,
  sourceWorkspaceCreatedSchema,
  sourceWorkspaceInfoSchema,
  staticSnapshotSchema,
  startTurnRequestSchema
} from '@ui-agent/contracts';
import { UiChangeAgent } from '@ui-agent/ui-change-agent';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logPageHtml } from './log-page';
import { TurnLogStore } from './log-store';
import { SnapshotStore } from './snapshot-store';
import { SourceWorkspaceStore } from './source-workspace-store';
import { SourceTurnProgressStore } from './source-turn-progress-store';

export function createApp(
  env: NodeJS.ProcessEnv = process.env,
  providedLogStore?: TurnLogStore,
  providedSnapshotStore?: SnapshotStore,
  providedWorkspaceStore?: SourceWorkspaceStore,
  providedCodingAgent?: CodingAgentPort
) {
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
  const snapshotStore = providedSnapshotStore ?? new SnapshotStore();
  const workspaceStore = providedWorkspaceStore ?? new SourceWorkspaceStore(
    env.SOURCE_WORKSPACE_DIR ?? '.snapshots/source-workspaces'
  );
  const codingAgent = providedCodingAgent ?? codingAgentPortFromEnvironment(env);
  const sourceProgress = new SourceTurnProgressStore();
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
      }),
      codingAgentAdapter: codingAgent.adapterId
    }))
    .post('/v1/snapshots', zValidator('json', staticSnapshotSchema), c => {
      try {
        const snapshot = snapshotStore.create(c.req.valid('json'));
        const previewUrl = new URL(`/snapshots/${snapshot.snapshotId}`, c.req.url).toString();
        return c.json(snapshotCreatedSchema.parse({ snapshotId: snapshot.snapshotId, previewUrl }), 201);
      } catch (error) {
        return c.json({
          code: 'SNAPSHOT_REJECTED',
          message: error instanceof Error ? error.message : '静态快照保存失败'
        }, 400);
      }
    })
    .get('/snapshots/:snapshotId', c => {
      const snapshot = snapshotStore.get(c.req.param('snapshotId'));
      if (!snapshot) return c.text('静态快照不存在或 Agent Service 已重新启动', 404);
      c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'");
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Referrer-Policy', 'no-referrer');
      c.header('Cache-Control', 'no-store');
      return c.html(snapshot.html);
    })
    .post('/v1/workspaces', zValidator('json', staticSnapshotSchema), c => {
      try {
        const workspace = workspaceStore.create(c.req.valid('json'));
        const previewUrl = new URL(`/workspaces/${workspace.workspaceId}/preview`, c.req.url).toString();
        return c.json(sourceWorkspaceCreatedSchema.parse({ ...workspace, previewUrl }), 201);
      } catch (error) {
        return c.json({
          code: 'WORKSPACE_CREATE_FAILED',
          message: error instanceof Error ? error.message : '静态源码工作区创建失败'
        }, 400);
      }
    })
    .get('/v1/workspaces/:workspaceId', c => {
      try {
        const workspace = workspaceStore.get(c.req.param('workspaceId'));
        if (!workspace) return c.json({ code: 'WORKSPACE_NOT_FOUND', message: '静态源码工作区不存在' }, 404);
        const previewUrl = new URL(`/workspaces/${workspace.workspaceId}/preview`, c.req.url).toString();
        return c.json(sourceWorkspaceInfoSchema.parse({ ...workspace, previewUrl }));
      } catch (error) {
        return c.json({ code: 'WORKSPACE_NOT_FOUND', message: error instanceof Error ? error.message : '工作区不存在' }, 404);
      }
    })
    .get('/workspaces/:workspaceId/preview', c => {
      try {
        const html = workspaceStore.previewHtml(c.req.param('workspaceId'));
        if (!html) return c.text('静态源码副本不存在', 404);
        c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; script-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'");
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Referrer-Policy', 'no-referrer');
        c.header('Cache-Control', 'no-store');
        return c.html(html);
      } catch {
        return c.text('静态源码副本不存在', 404);
      }
    })
    .post('/v1/workspaces/:workspaceId/turns', zValidator('json', sourceTurnRequestSchema), async c => {
      const request = c.req.valid('json');
      const workspaceId = c.req.param('workspaceId');
      const startedAt = Date.now();
      sourceProgress.start(workspaceId, request.turnId);
      try {
        const conversation = workspaceStore.conversation(workspaceId);
        const tools = workspaceStore.tools(workspaceId);
        const run = await codingAgent.run({
          workspaceId,
          request,
          conversation
        }, tools, event => sourceProgress.observe(workspaceId, request.turnId, event));
        const result = run.response;
        sourceProgress.complete(
          workspaceId,
          request.turnId,
          result.kind === 'failed',
          run.checkpoint.modelCalls,
          run.checkpoint.toolCalls
        );
        workspaceStore.recordTurn(workspaceId, request.instruction, result);
        logStore.recordSourceTurn(
          workspaceId,
          request,
          conversation,
          result,
          run.steps,
          Date.now() - startedAt,
          { adapterId: codingAgent.adapterId, checkpoint: run.checkpoint }
        );
        return c.json(result, result.kind === 'failed' ? 500 : 200);
      } catch (error) {
        const result = {
          kind: 'failed' as const,
          code: 'SOURCE_TURN_ERROR',
          message: error instanceof Error ? error.message : '源码修改失败'
        };
        logStore.recordSourceTurn(workspaceId, request, [], result, [], Date.now() - startedAt);
        sourceProgress.fail(workspaceId, request.turnId, result.message);
        return c.json(result, 500);
      }
    })
    .get('/v1/workspaces/:workspaceId/turns/:turnId/progress', c => {
      const progress = sourceProgress.get(c.req.param('workspaceId'), c.req.param('turnId'));
      return progress
        ? c.json(sourceTurnProgressSchema.parse(progress))
        : c.json({ code: 'TURN_PROGRESS_NOT_FOUND', message: '该 Turn 尚未开始或进度已清理' }, 404);
    })
    .post('/v1/workspaces/:workspaceId/undo', c => {
      try {
        return c.json(workspaceStore.undo(c.req.param('workspaceId')));
      } catch (error) {
        return c.json({ code: 'WORKSPACE_UNDO_FAILED', message: error instanceof Error ? error.message : '撤销失败' }, 409);
      }
    })
    .post('/v1/workspaces/:workspaceId/redo', c => {
      try {
        return c.json(workspaceStore.redo(c.req.param('workspaceId')));
      } catch (error) {
        return c.json({ code: 'WORKSPACE_REDO_FAILED', message: error instanceof Error ? error.message : '重做失败' }, 409);
      }
    })
    .post('/v1/workspaces/:workspaceId/reset', c => {
      try {
        return c.json(workspaceStore.reset(c.req.param('workspaceId')));
      } catch (error) {
        return c.json({ code: 'WORKSPACE_RESET_FAILED', message: error instanceof Error ? error.message : '恢复初始版本失败' }, 409);
      }
    })
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
