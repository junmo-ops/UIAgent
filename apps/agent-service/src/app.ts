import { zValidator } from '@hono/zod-validator';
import {
  clineAssistantChatFromEnvironment,
  clineAssistantRouterFromEnvironment,
  clineCodingAgentFromEnvironment,
  type AssistantChatPort,
  type AssistantRouterPort,
  type CodingAgentPort
} from '@ui-agent/agent-runtime';
import {
  assistantTurnRequestSchema,
  assistantTurnResponseSchema,
  sourceTurnRequestSchema,
  sourceTurnAcceptedSchema,
  sourceTurnProgressSchema,
  sourceWorkspaceCreatedSchema,
  sourceWorkspaceInfoSchema,
  workspaceListResponseSchema,
  workspaceUpdateRequestSchema,
  installationCredentialSchema,
  staticSnapshotSchema
} from '@ui-agent/contracts';
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  createAuthenticatorFromEnvironment,
  type Authenticator,
  type AuthPrincipal
} from './auth/authenticator';
import { logPageHtml } from './observability/log-page';
import { TurnLogStore } from './observability/log-store';
import { SourceWorkspaceStore } from './workspace/store';
import { SourceTurnProgressStore } from './progress/source-turn-progress-store';

export function createApp(
  env: NodeJS.ProcessEnv = process.env,
  providedLogStore?: TurnLogStore,
  providedWorkspaceStore?: SourceWorkspaceStore,
  providedCodingAgent?: CodingAgentPort,
  providedAuthenticator?: Authenticator,
  providedAssistantRouter?: AssistantRouterPort,
  providedAssistantChat?: AssistantChatPort
) {
  const publicBaseUrl = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  const publicUrl = (path: string, requestUrl: string) => new URL(path, publicBaseUrl ? `${publicBaseUrl}/` : requestUrl).toString();
  const logStore = providedLogStore ?? new TurnLogStore({
    filePath: env.LOG_FILE ?? '.logs/agent-turns.jsonl',
    model: {
      mode: env.MODEL_MODE ?? 'mock',
      provider: env.MODEL_PROVIDER ?? (env.MODEL_MODE === 'remote' ? 'openai-compatible' : 'mock'),
      name: env.MODEL_NAME
    }
  });
  const workspaceStore = providedWorkspaceStore ?? new SourceWorkspaceStore(
    env.SOURCE_WORKSPACE_DIR ?? '.snapshots/source-workspaces'
  );
  const codingAgent = providedCodingAgent ?? clineCodingAgentFromEnvironment(env);
  const assistantRouter: AssistantRouterPort = providedAssistantRouter
    ?? (env.MODEL_MODE === 'remote'
      ? clineAssistantRouterFromEnvironment(env)
      : {
          adapterId: 'assistant-router-unavailable',
          async route() {
            return {
              kind: 'failed',
              code: 'ASSISTANT_MODEL_UNAVAILABLE',
              message: '当前服务未配置远程模型，无法使用智能问答'
            };
          }
        });
  const assistantChat: AssistantChatPort = providedAssistantChat
    ?? (env.MODEL_MODE === 'remote'
      ? clineAssistantChatFromEnvironment(env)
      : {
          adapterId: 'assistant-chat-unavailable',
          async answer() {
            throw new Error('当前服务未配置远程模型，无法使用智能问答');
          }
        });
  const authenticator = providedAuthenticator ?? createAuthenticatorFromEnvironment(env);
  const workspacePreviewUrl = (workspaceId: string, requestUrl: string, principal: AuthPrincipal) => {
    const url = new URL(publicUrl(`/workspaces/${workspaceId}/preview`, requestUrl));
    const previewToken = authenticator.createPreviewToken?.(principal, workspaceId);
    if (previewToken) url.searchParams.set('preview_token', previewToken);
    return url.toString();
  };
  const sourceProgress = new SourceTurnProgressStore();
  type AppBindings = { Variables: { principal: AuthPrincipal } };
  const authenticate: MiddlewareHandler<AppBindings> = async (c, next) => {
    const principal = await authenticator.authenticate(c.req.raw);
    if (!principal) {
      return c.json({ code: 'AUTHENTICATION_REQUIRED', message: '请先登录后再访问副本' }, 401);
    }
    c.set('principal', principal);
    await next();
  };
  const authorizeWorkspace: MiddlewareHandler<AppBindings> = async (c, next) => {
    const workspaceId = c.req.param('workspaceId');
    if (!workspaceId || !workspaceStore.owns(workspaceId, c.get('principal'))) {
      return c.json({ code: 'WORKSPACE_NOT_FOUND', message: '工作区不存在' }, 404);
    }
    await next();
  };
  const authorizeAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
    if (!c.get('principal').roles.includes('admin')) {
      return c.json({ code: 'ADMIN_REQUIRED', message: '仅管理员可以访问运行日志' }, 403);
    }
    await next();
  };
  const executeSourceTurn = async (workspaceId: string, request: ReturnType<typeof sourceTurnRequestSchema.parse>) => {
    const startedAt = Date.now();
    try {
      const conversation = workspaceStore.conversation(workspaceId);
      const tools = workspaceStore.tools(workspaceId);
      const run = await codingAgent.run({ workspaceId, request, conversation }, tools, event => sourceProgress.observe(workspaceId, request.turnId, event));
      const result = run.response;
      sourceProgress.complete(workspaceId, request.turnId, result, run.checkpoint.modelCalls, run.checkpoint.toolCalls);
      workspaceStore.recordTurn(workspaceId, request, result);
      logStore.recordSourceTurn(workspaceId, request, conversation, result, run.steps, Date.now() - startedAt, { adapterId: codingAgent.adapterId, checkpoint: run.checkpoint });
    } catch (error) {
      const result = { kind: 'failed' as const, code: 'SOURCE_TURN_ERROR', message: error instanceof Error ? error.message : '源码修改失败' };
      logStore.recordSourceTurn(workspaceId, request, [], result, [], Date.now() - startedAt);
      sourceProgress.fail(workspaceId, request.turnId, result.message, result);
    }
  };

  return new Hono<AppBindings>()
    .use('*', cors({
      origin: env.CORS_ORIGIN?.trim() || '*',
      allowHeaders: ['Authorization', 'Content-Type', 'traceparent'],
      credentials: Boolean(env.CORS_ORIGIN?.trim())
    }))
    .use('/v1/workspaces', authenticate)
    .use('/v1/workspaces/*', authenticate)
    .use('/v1/assistant/*', authenticate)
    .use('/v1/auth/installations/refresh', authenticate)
    .use('/workspaces/*', authenticate)
    .use('/logs', authenticate)
    .use('/v1/logs', authenticate)
    .use('/v1/logs/*', authenticate)
    .use('/v1/workspaces/:workspaceId', authorizeWorkspace)
    .use('/v1/workspaces/:workspaceId/*', authorizeWorkspace)
    .use('/workspaces/:workspaceId/*', authorizeWorkspace)
    .use('/logs', authorizeAdmin)
    .use('/v1/logs', authorizeAdmin)
    .use('/v1/logs/*', authorizeAdmin)
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
      codingAgentAdapter: codingAgent.adapterId,
      assistantRouterAdapter: assistantRouter.adapterId,
      assistantChatAdapter: assistantChat.adapterId,
      authMode: authenticator.mode ?? 'external',
      authReady: !authenticator.configurationError
    }))
    .post('/v1/auth/installations', c => {
      if (authenticator.mode === 'installation' && authenticator.configurationError) {
        return c.json({ code: 'INSTALLATION_AUTH_MISCONFIGURED', message: authenticator.configurationError }, 503);
      }
      if (!authenticator.issueInstallation) {
        return c.json({ code: 'INSTALLATION_AUTH_DISABLED', message: '服务未启用安装身份认证' }, 404);
      }
      return c.json(installationCredentialSchema.parse(authenticator.issueInstallation()), 201);
    })
    .post('/v1/auth/installations/refresh', c => {
      const credential = authenticator.refreshInstallation?.(c.get('principal'));
      return credential
        ? c.json(installationCredentialSchema.parse(credential))
        : c.json({ code: 'INSTALLATION_REFRESH_UNAVAILABLE', message: '当前身份不能续期' }, 409);
    })
    .post('/v1/assistant/turns', zValidator('json', assistantTurnRequestSchema), async c => {
      const request = c.req.valid('json');
      const route = await assistantRouter.route(request);
      const response = route.kind === 'chat'
        ? { kind: 'answered' as const, answer: await assistantChat.answer(request, undefined, c.req.raw.signal) }
        : route;
      return c.json(
        assistantTurnResponseSchema.parse(response),
        response.kind === 'failed' ? 500 : 200
      );
    })
    .post('/v1/assistant/turns/stream', zValidator('json', assistantTurnRequestSchema), async c => {
      const request = c.req.valid('json');
      c.header('Cache-Control', 'no-cache, no-transform');
      c.header('X-Accel-Buffering', 'no');
      return streamSSE(c, async stream => {
        const send = (event: unknown) => stream.writeSSE({ data: JSON.stringify(event) });
        try {
          const route = await assistantRouter.route(request);
          if (route.kind !== 'chat') {
            await send(route.kind === 'failed'
              ? { type: 'error', code: route.code, message: route.message }
              : { type: 'result', result: route });
            return;
          }
          let emittedText = false;
          let pendingWrite = Promise.resolve();
          const answer = await assistantChat.answer(request, text => {
            emittedText = true;
            pendingWrite = pendingWrite.then(() => send({ type: 'answer_delta', text }));
          }, c.req.raw.signal);
          await pendingWrite;
          if (!emittedText) await send({ type: 'answer_delta', text: answer });
          await send({ type: 'result', result: { kind: 'answered', answer } });
        } catch (error) {
          await send({
            type: 'error',
            code: 'ASSISTANT_STREAM_ERROR',
            message: error instanceof Error ? error.message : '普通聊天流式输出失败'
          });
        }
      });
    })
    .get('/v1/workspaces', c => {
      const rawOffset = Number(c.req.query('offset') ?? 0);
      const rawLimit = Number(c.req.query('limit') ?? 30);
      const statusValue = c.req.query('status');
      const status = statusValue === 'trashed' || statusValue === 'all' ? statusValue : 'active';
      const result = workspaceStore.list({
        query: c.req.query('query'),
        status,
        offset: Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
        limit: Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 30
      }, c.get('principal'));
      return c.json(workspaceListResponseSchema.parse({
        ...result,
        items: result.items.map(item => ({
          ...item,
          previewUrl: workspacePreviewUrl(item.workspaceId, c.req.url, c.get('principal'))
        }))
      }));
    })
    .post('/v1/workspaces', zValidator('json', staticSnapshotSchema), c => {
      try {
        const workspace = workspaceStore.create(c.req.valid('json'), c.get('principal'));
        const previewUrl = workspacePreviewUrl(workspace.workspaceId, c.req.url, c.get('principal'));
        return c.json(sourceWorkspaceCreatedSchema.parse({ ...workspace, previewUrl }), 201);
      } catch (error) {
        return c.json({
          code: 'WORKSPACE_CREATE_FAILED',
          message: error instanceof Error ? error.message : '静态源码工作区创建失败'
        }, 400);
      }
    })
    .patch('/v1/workspaces/:workspaceId', zValidator('json', workspaceUpdateRequestSchema), c => {
      try {
        const workspace = workspaceStore.rename(c.req.param('workspaceId'), c.req.valid('json').title);
        return c.json(sourceWorkspaceInfoSchema.parse({
          ...workspace,
          previewUrl: workspacePreviewUrl(workspace.workspaceId, c.req.url, c.get('principal'))
        }));
      } catch (error) {
        return c.json({ code: 'WORKSPACE_UPDATE_FAILED', message: error instanceof Error ? error.message : '副本更新失败' }, 409);
      }
    })
    .delete('/v1/workspaces/:workspaceId', c => {
      try {
        const workspace = workspaceStore.trash(c.req.param('workspaceId'));
        return c.json({ workspaceId: workspace.workspaceId, deletedAt: workspace.deletedAt });
      } catch (error) {
        return c.json({ code: 'WORKSPACE_DELETE_FAILED', message: error instanceof Error ? error.message : '副本移入回收站失败' }, 409);
      }
    })
    .post('/v1/workspaces/:workspaceId/restore', c => {
      try {
        const workspace = workspaceStore.restoreWorkspace(c.req.param('workspaceId'));
        return c.json(sourceWorkspaceInfoSchema.parse({
          ...workspace,
          previewUrl: workspacePreviewUrl(workspace.workspaceId, c.req.url, c.get('principal'))
        }));
      } catch (error) {
        return c.json({ code: 'WORKSPACE_RESTORE_FAILED', message: error instanceof Error ? error.message : '副本恢复失败' }, 409);
      }
    })
    .get('/v1/workspaces/:workspaceId', c => {
      try {
        const workspace = workspaceStore.get(c.req.param('workspaceId'));
        if (!workspace) return c.json({ code: 'WORKSPACE_NOT_FOUND', message: '静态源码工作区不存在' }, 404);
        const previewUrl = workspacePreviewUrl(workspace.workspaceId, c.req.url, c.get('principal'));
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
      const existing = sourceProgress.get(workspaceId, request.turnId);
      if (existing) return c.json(sourceTurnAcceptedSchema.parse({ kind: 'accepted', turnId: request.turnId }), 202);
      sourceProgress.start(workspaceId, request.turnId);
      void executeSourceTurn(workspaceId, request);
      return c.json(sourceTurnAcceptedSchema.parse({ kind: 'accepted', turnId: request.turnId }), 202);
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
    });
}

export type AgentApp = ReturnType<typeof createApp>;
