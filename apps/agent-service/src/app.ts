import { readServiceConfig, type ServiceConfig } from './configuration/service-config';
import { SkillRegistry } from './skills/registry';
import { readWorkspaceStorageConfig } from './storage/config';
import { WorkspaceStorageError } from './storage/s3-workspace-storage';
import { zValidator } from '@hono/zod-validator';
import { fetchWorkspaceResource, resourceErrorCode } from './workspace/resource-fetch';
import {
  ClineAssistantChatAdapter,
  ClineAssistantRouterAdapter,
  clineCodingAgentFromConfig,
  type AssistantChatPort,
  type AssistantChatRun,
  type AssistantRouterPort,
  type CodingAgentPort
} from '@ui-agent/agent-runtime';
import {
  assistantTurnRequestSchema,
  type AssistantTurnResponse,
  assistantTurnResponseSchema,
  sourceTurnRequestSchema,
  sourceTurnAcceptedSchema,
  sourceTurnProgressSchema,
  sourceWorkspaceCreatedSchema,
  sourceWorkspaceInfoSchema,
  workspaceChatEntrySchema,
  workspaceConversationResponseSchema,
  workspaceConversationsSchema,
  workspaceListResponseSchema,
  workspaceUpdateRequestSchema,
  installationCredentialSchema,
  staticSnapshotSchema,
  workspaceArchiveSchema,
  WORKSPACE_ARCHIVE_FORMAT,
  WORKSPACE_ARCHIVE_VERSION
} from '@ui-agent/contracts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  createAuthenticator,
  type Authenticator,
  type AuthPrincipal
} from './auth/authenticator';
import { logPageHtml } from './observability/log-page';
import { TurnLogStore } from './observability/log-store';
import { SourceWorkspaceStore } from './workspace/store';
import { SourceTurnProgressStore } from './progress/source-turn-progress-store';
import { SourceTurnService } from './tasks/source-turn-service';
import { createSourceTurnExecutor } from './tasks/source-turn-executor';
import { TurnProgressStorage } from './tasks/turn-progress-storage';

export function createApp(
  env: NodeJS.ProcessEnv = process.env,
  providedLogStore?: TurnLogStore,
  providedWorkspaceStore?: SourceWorkspaceStore,
  providedCodingAgent?: CodingAgentPort,
  providedAuthenticator?: Authenticator,
  providedAssistantRouter?: AssistantRouterPort,
  providedAssistantChat?: AssistantChatPort,
  providedConfig?: ServiceConfig
) {
  const config = providedConfig ?? readServiceConfig();
  const storageConfig = readWorkspaceStorageConfig();
  if (storageConfig.mode === 's3' && !providedWorkspaceStore?.persistence?.ready) {
    throw new Error('S3 模式必须通过已完成恢复的存储实例启动');
  }
  const publicBaseUrl = config.http.publicBaseUrl.replace(/\/+$/, '');
  const publicUrl = (path: string, requestUrl: string) => new URL(path, publicBaseUrl ? `${publicBaseUrl}/` : requestUrl).toString();
  const extensionReleaseDirectory = fileURLToPath(new URL('../extension-release/', import.meta.url));
  const replicaRuntimePath = fileURLToPath(new URL('../replica-runtime/ui-agent-module.js', import.meta.url));
  const replicaRuntime = existsSync(replicaRuntimePath) ? readFileSync(replicaRuntimePath) : undefined;
  const replicaRuntimeEtag = replicaRuntime
    ? `"${createHash('sha256').update(replicaRuntime).digest('hex').slice(0, 16)}"`
    : undefined;
  const extensionReleaseManifestPath = `${extensionReleaseDirectory}/manifest.json`;
  const extensionReleaseZipPath = `${extensionReleaseDirectory}/ui-agent-extension.zip`;
  const extensionRelease = (() => {
    if (!existsSync(extensionReleaseManifestPath) || !existsSync(extensionReleaseZipPath)) return undefined;
    try {
      const value = JSON.parse(readFileSync(extensionReleaseManifestPath, 'utf8')) as Record<string, unknown>;
      if (typeof value.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(value.version)) return undefined;
      return {
        version: value.version,
        ...(typeof value.releaseNotes === 'string' && value.releaseNotes.trim()
          ? { releaseNotes: value.releaseNotes.trim() }
          : {}),
        ...(typeof value.publishedAt === 'string' && value.publishedAt.trim()
          ? { publishedAt: value.publishedAt.trim() }
          : {})
      };
    } catch {
      return undefined;
    }
  })();
  const logStore = providedLogStore ?? new TurnLogStore({
    filePath: config.logging.file,
    model: {
      mode: 'remote',
      provider: config.model.providerLabel,
      name: config.model.name
    }
  });
  const identityIsolation = true;
  const frozenStyleVariantEnabled = config.diagnostics.replicaAEnabled;
  const aVariantDisabledMessage = 'A 方案当前已关闭；该副本缺少可用的 B 方案作者样式资源';
  const supportsAuthorRuleVariant = (snapshot: ReturnType<typeof staticSnapshotSchema.parse>) => {
    const capture = snapshot.authorStyles;
    return Boolean(capture && (
      capture.cssText.trim()
      || (capture.unreadableSources?.length ?? 0) > 0
      || capture.sheets?.some(sheet => sheet.renderOnly || Boolean(sheet.cssText?.trim()))
    ));
  };
  const workspaceStore = providedWorkspaceStore ?? new SourceWorkspaceStore(
    storageConfig.cacheDirectory,
    { identityIsolation, frozenStyleVariantEnabled }
  );
  const modelOptions = () => {
    const apiKey = env.MODEL_API_KEY?.trim();
    if (!apiKey) throw new Error('缺少 MODEL_API_KEY，请通过 Secret 注入模型密钥');
    return { baseUrl: config.model.baseUrl, modelName: config.model.name, apiKey };
  };
  const skills = new SkillRegistry();
  for (const issue of skills.issues) console.warn('[skills] Disabled package:', issue);
  const codingAgent = providedCodingAgent ?? clineCodingAgentFromConfig({ ...modelOptions(), ...config.model.edit, skills });
  const assistantRouter: AssistantRouterPort = providedAssistantRouter
    ?? new ClineAssistantRouterAdapter({ ...modelOptions(), ...config.model.router, skills });
  const assistantChat: AssistantChatPort = providedAssistantChat ?? new ClineAssistantChatAdapter({ ...modelOptions(), skills });
  const answerWithLog: AssistantChatPort['answer'] = async (request, observeText, signal) => {
    const startedAt = Date.now();
    let run: AssistantChatRun | undefined;
    let response: AssistantTurnResponse | undefined;
    try {
      const answer = await assistantChat.answer(request, observeText, signal, value => { run = value; });
      response = { kind: 'answered', answer };
      return answer;
    } catch (error) {
      response = { kind: 'failed', code: signal?.aborted ? 'ASSISTANT_CANCELLED' : 'ASSISTANT_CHAT_ERROR',
        message: signal?.aborted ? '用户已停止本轮问答' : error instanceof Error ? error.message : '问答执行失败' };
      throw error;
    } finally {
      if (response) {
        try { logStore.recordAssistantTurn(request, response, Date.now() - startedAt, assistantChat.adapterId, run); }
        catch { console.error('[assistant-log] Failed to write diagnostic log'); }
      }
    }
  };
  const authenticator = providedAuthenticator ?? createAuthenticator(config.auth, env);
  const workspacePreviewUrl = (workspaceId: string, requestUrl: string, principal: AuthPrincipal) => {
    const url = new URL(publicUrl(`/workspaces/${workspaceId}/preview`, requestUrl));
    if (workspaceStore.hasAuthorRuleCandidate(workspaceId)) url.searchParams.set('candidate', 'B');
    else if (frozenStyleVariantEnabled) url.searchParams.set('candidate', 'A');
    const previewToken = authenticator.createPreviewToken?.(principal, workspaceId);
    if (previewToken) url.searchParams.set('preview_token', previewToken);
    return url.toString();
  };
  const sourceProgress = new SourceTurnProgressStore(new TurnProgressStorage(() => workspaceStore.root, () => !workspaceStore.persistence || workspaceStore.persistence.inTransaction), workspaceStore.persistence);
  const sourceTurns = new SourceTurnService(sourceProgress);
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
    workspaceStore.persistence?.assertAvailable(workspaceId === 'export-all' ? undefined : workspaceId);
    // Collection-level routes share the /v1/workspaces prefix but do not name
    // a workspace. They remain protected by authenticate above.
    if (workspaceId === 'export-all') return next();
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
  const executeSourceTurn = createSourceTurnExecutor({ workspaceStore, codingAgent, sourceProgress, logStore });

  // All ordinary HTTP mutations share the same commit boundary as Agent execution.
  const persistMutation: MiddlewareHandler<AppBindings> = async (c, next) => {
    const persistence = workspaceStore.persistence;
    if (!persistence || persistence.inTransaction) return next();
    const id = c.req.param('workspaceId');
    persistence.assertAvailable(id === 'export-all' ? undefined : id);
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || /\/turns(?:\/|$)/.test(c.req.path)) return next();
    if (id && sourceTurns.has(id)) return c.json({ code: 'WORKSPACE_BUSY', message: '副本正在修改，请等待任务完成或先停止任务' }, 409);
    await persistence.run(id, () => next(), { commit: () => c.res.status < 400 });
  };

  return new Hono<AppBindings>()
    .onError((error, c) => {
      if (error instanceof WorkspaceStorageError) return c.json({ code: error.code, message: error.message }, ['WORKSPACE_BUSY', 'WORKSPACE_ARCHIVE_INVALID'].includes(error.code) ? 409 : 503);
      console.error('[agent-service] request failed', error.name);
      return c.json({ code: 'INTERNAL_ERROR', message: '服务处理失败' }, 500);
    })
    .use('*', cors({
      origin: config.http.corsOrigin || '*',
      allowHeaders: ['Authorization', 'Content-Type', 'traceparent'],
      credentials: Boolean(config.http.corsOrigin)
    }))
    .use('/v1/workspaces', authenticate)
    .use('/v1/workspaces/*', authenticate)
    .use('/v1/assistant/*', authenticate)
    .use('/v1/skills', authenticate)
    .use('/v1/auth/installations/refresh', authenticate)
    .use('/v1/auth/me', authenticate)
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
    .use('/v1/workspaces', persistMutation)
    .use('/v1/workspaces/:workspaceId', persistMutation)
    .use('/v1/workspaces/:workspaceId/*', persistMutation)
    .get('/ready', c => c.json({ ready: workspaceStore.persistence?.healthy ?? true }, (workspaceStore.persistence?.healthy ?? true) ? 200 : 503))
    .get('/v1/auth/me', c => c.json(c.get('principal')))
    .get('/v1/skills', c => c.json({ skills: skills.list(), pythonAvailable: skills.pythonAvailable }))
    .get('/logs', c => c.html(logPageHtml))
    .get('/v1/logs', c => c.json(logStore.list()))
    .get('/v1/logs/:id', c => {
      const entry = logStore.get(c.req.param('id'));
      return entry ? c.json(entry, 200) : c.json({ code: 'LOG_NOT_FOUND', message: '日志不存在或已被轮转' }, 404);
    })
    .get('/health', c => c.json({
      ok: true,
      replicaAEnabled: frozenStyleVariantEnabled,
      modelMode: 'remote',
      modelProvider: config.model.providerLabel,
      modelName: config.model.name,
      codingAgentAdapter: codingAgent.adapterId,
      assistantRouterAdapter: assistantRouter.adapterId,
      assistantChatAdapter: assistantChat.adapterId,
      authMode: authenticator.mode ?? 'external',
      authReady: !authenticator.configurationError,
      workspaceIdentityIsolation: identityIsolation,
      replicaComponentRuntimeReady: Boolean(replicaRuntime),
    }))
    .get('/v1/extension/latest', c => {
      if (!extensionRelease) return c.body(null, 204);
      return c.json({
        ...extensionRelease,
        downloadUrl: publicUrl('/v1/extension/download', c.req.url)
      });
    })
    .get('/v1/extension/download', c => {
      if (!extensionRelease || !existsSync(extensionReleaseZipPath)) {
        return c.json({ code: 'EXTENSION_RELEASE_NOT_FOUND', message: '当前服务未包含插件更新包' }, 404);
      }
      const archive = readFileSync(extensionReleaseZipPath);
      c.header('Content-Type', 'application/zip');
      c.header('Content-Disposition', `attachment; filename="ui-agent-extension-${extensionRelease.version}.zip"`);
      c.header('Content-Length', String(archive.byteLength));
      c.header('Cache-Control', 'public, max-age=3600');
      return c.body(new Uint8Array(archive).buffer as ArrayBuffer);
    })
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
        ? { kind: 'answered' as const, answer: await answerWithLog({ ...request, skillId: route.skillId, skillVersion: route.skillVersion }, undefined, c.req.raw.signal) }
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
        const disconnected = new AbortController();
        stream.onAbort(() => disconnected.abort());
        const signal = AbortSignal.any([c.req.raw.signal, disconnected.signal]);
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
          const answer = await answerWithLog({ ...request, skillId: route.skillId, skillVersion: route.skillVersion }, text => {
            emittedText = true;
            pendingWrite = pendingWrite.then(() => send({ type: 'answer_delta', text }));
          }, signal);
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
      const result = workspaceStore.list({
        query: c.req.query('query'),
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
        const snapshot = c.req.valid('json');
        if (!frozenStyleVariantEnabled && !supportsAuthorRuleVariant(snapshot)) {
          return c.json({ code: 'AUTHOR_RULES_UNAVAILABLE', message: aVariantDisabledMessage }, 409);
        }
        const workspace = workspaceStore.create(snapshot, c.get('principal'));
        const previewUrl = workspacePreviewUrl(workspace.workspaceId, c.req.url, c.get('principal'));
        return c.json(sourceWorkspaceCreatedSchema.parse({ ...workspace, previewUrl }), 201);
      } catch (error) {
        return c.json({
          code: 'WORKSPACE_CREATE_FAILED',
          message: error instanceof Error ? error.message : '静态源码工作区创建失败'
        }, 400);
      }
    })
    .get('/v1/workspaces/export-all', c => {
      try {
        const snapshots = workspaceStore.exportActiveSnapshots(c.get('principal'));
        if (!snapshots.length) return c.json({ code: 'WORKSPACE_ARCHIVE_EMPTY', message: '没有可导出的副本' }, 409);
        const exportedAt = new Date().toISOString();
        const archive = workspaceArchiveSchema.parse({
          format: WORKSPACE_ARCHIVE_FORMAT,
          version: WORKSPACE_ARCHIVE_VERSION,
          exportedAt,
          workspaces: snapshots.map(snapshot => ({
            format: 'ui-agent-static-snapshot',
            version: 1,
            exportedAt,
            snapshot,
            safety: {
              activeContentRemoved: true,
              browserStateExcluded: ['cookies', 'localStorage', 'sessionStorage']
            }
          }))
        });
        c.header('content-type', 'application/json; charset=utf-8');
        return c.json(archive);
      } catch (error) {
        return c.json({ code: 'WORKSPACE_ARCHIVE_EXPORT_FAILED', message: error instanceof Error ? error.message : '一键导出失败' }, 400);
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
        const workspaceId = c.req.param('workspaceId');
        if (sourceTurns.has(workspaceId)) throw new Error('任务执行期间不能删除副本，请先停止或等待完成');
        workspaceStore.deleteWorkspace(workspaceId);
        return c.json({ workspaceId, deleted: true });
      } catch (error) {
        return c.json({ code: 'WORKSPACE_DELETE_FAILED', message: error instanceof Error ? error.message : '副本永久删除失败' }, 409);
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
    .get('/v1/workspaces/:workspaceId/diagnostics', c => {
      try {
        const workspace = workspaceStore.get(c.req.param('workspaceId'));
        return c.json({
          workspaceId: c.req.param('workspaceId'),
          revision: workspace?.revision ?? 0,
          candidate: 'A-frozen-computed-style',
          diagnostics: { ...workspaceStore.diagnostics(c.req.param('workspaceId')), replicaAEnabled: frozenStyleVariantEnabled },
          capability: workspace?.snapshotMetrics ? {
            authorReadableSheets: workspace.snapshotMetrics.authorReadableSheets ?? null,
            authorUnreadableSheets: workspace.snapshotMetrics.authorUnreadableSheets ?? null,
            authorMissingSources: workspace.snapshotMetrics.authorMissingSources ?? [],
            authorResources: workspaceStore.authorStyleResources(c.req.param('workspaceId')).length
          } : null
        });
      } catch (error) {
        return c.json({ code: 'WORKSPACE_DIAGNOSTICS_NOT_FOUND', message: error instanceof Error ? error.message : '工作区诊断失败' }, 404);
      }
    })
    .get('/v1/workspaces/:workspaceId/author-styles', c => {
      try {
        const styles = workspaceStore.authorStyles(c.req.param('workspaceId'));
        const capture = workspaceStore.authorStyleCapture(c.req.param('workspaceId'));
        const resources = workspaceStore.authorStyleResources(c.req.param('workspaceId'));
        return c.json({
          workspaceId: c.req.param('workspaceId'),
          candidate: 'B-author-rules',
          ...styles,
          capture: capture ? {
            readableSheets: capture.readableSheets,
            unreadableSheets: capture.unreadableSheets,
            missing: capture.missing,
            sources: capture.sources ?? [],
            renderOnlySources: workspaceStore.unreadableAuthorStyleSources(c.req.param('workspaceId'))
          } : null,
          resources: {
            count: resources.length,
            origins: [...new Set(resources.map(resource => new URL(resource.url).origin))],
            byKind: Object.fromEntries(['image', 'font', 'other'].map(kind => [kind, resources.filter(resource => resource.kind === kind).length]))
          }
        });
      } catch (error) {
        return c.json({ code: 'WORKSPACE_AUTHOR_STYLES_NOT_FOUND', message: error instanceof Error ? error.message : '原始样式不可用' }, 404);
      }
    })
    .get('/workspaces/:workspaceId/author.css', c => {
      try {
        const previewToken = c.req.query('preview_token');
        const assetQuery = previewToken ? `?preview_token=${encodeURIComponent(previewToken)}` : '';
        const css = workspaceStore.authorCssForPreview(c.req.param('workspaceId'), assetQuery);
        if (css === undefined) return c.text('原始样式不可用', 404);
        c.header('Content-Type', 'text/css; charset=utf-8');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Cache-Control', 'no-store');
        return c.body(css);
      } catch (error) {
        return c.text(`原始样式不可用：${error instanceof Error ? error.message : '未知错误'}`, 404);
      }
    })
    .get('/workspaces/:workspaceId/author-overrides.css', c => {
      try {
        const css = workspaceStore.authorOverrides(c.req.param('workspaceId'));
        c.header('Content-Type', 'text/css; charset=utf-8');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Cache-Control', 'no-store');
        return c.body(css);
      } catch {
        return c.text('覆盖样式不可用', 404);
      }
    })
    .get('/workspaces/:workspaceId/replica-runtime.js', c => {
      if (!workspaceStore.get(c.req.param('workspaceId'))) return c.text('静态源码副本不存在', 404);
      if (!replicaRuntime || !replicaRuntimeEtag) return c.text('副本组件运行时尚未构建', 503);
      if (c.req.header('If-None-Match') === replicaRuntimeEtag) return c.body(null, 304);
      c.header('Content-Type', 'text/javascript; charset=utf-8');
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Cache-Control', 'private, no-cache');
      c.header('ETag', replicaRuntimeEtag);
      return c.body(new Uint8Array(replicaRuntime).buffer as ArrayBuffer);
    })
    .get('/workspaces/:workspaceId/module.js', c => {
      const source = workspaceStore.moduleJavaScript(c.req.param('workspaceId'));
      if (source === undefined) return c.text('局部模块源码不可用', 404);
      c.header('Content-Type', 'text/javascript; charset=utf-8');
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Cache-Control', 'no-store');
      return c.body(source);
    })
    .get('/workspaces/:workspaceId/author-sheets/:sheetIndex', c => {
      try {
        const previewToken = c.req.query('preview_token');
        const assetQuery = previewToken ? `?preview_token=${encodeURIComponent(previewToken)}` : '';
        const css = workspaceStore.authorStyleSheetCssForPreview(
          c.req.param('workspaceId'),
          Number(c.req.param('sheetIndex')),
          assetQuery
        );
        if (css === undefined) return c.text('原始样式不可用', 404);
        c.header('Content-Type', 'text/css; charset=utf-8');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Cache-Control', 'no-store');
        return c.body(css);
      } catch (error) {
        return c.text(`原始样式不可用：${error instanceof Error ? error.message : '未知错误'}`, 404);
      }
    })
    .get('/workspaces/:workspaceId/assets/:resourceIndex', async c => {
      const workspaceId = c.req.param('workspaceId');
      const resource = workspaceStore.authorStyleResource(workspaceId, Number(c.req.param('resourceIndex')));
      if (!resource) return c.text('样式资源不存在', 404);
      try {
        // Only recorded resources enter the proxy; redirects are bounded and
        // never forward browser cookies or authorization headers.
        const response = await fetchWorkspaceResource(resource.url);
        if (!response.ok) {
          workspaceStore.recordAuthorResourceFailure(workspaceId, Number(c.req.param('resourceIndex')), `HTTP ${response.status}`);
          return c.text(`样式资源请求失败 (${response.status})`, 502);
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 20 * 1024 * 1024) {
          workspaceStore.recordAuthorResourceFailure(workspaceId, Number(c.req.param('resourceIndex')), '资源超过 20 MB 限制');
          return c.text('样式资源超过 20 MB 限制', 413);
        }
        workspaceStore.clearAuthorResourceFailure(workspaceId, Number(c.req.param('resourceIndex')));
        c.header('Content-Type', response.headers.get('content-type') ?? 'application/octet-stream');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Cache-Control', 'private, max-age=3600');
        return c.body(bytes);
      } catch (error) {
        const code = resourceErrorCode(error);
        workspaceStore.recordAuthorResourceFailure(workspaceId, Number(c.req.param('resourceIndex')), code);
        console.warn('[resource-fetch]', { workspaceId, resourceIndex: c.req.param('resourceIndex'), host: new URL(resource.url).hostname, code });
        return c.text(`样式资源无法加载 (${code})`, code === 'RESOURCE_TOO_LARGE' ? 413 : 502);
      }
    })
    .get('/v1/workspaces/:workspaceId/conversations', c => {
      const workspaceId = c.req.param('workspaceId');
      const running = sourceTurns.get(workspaceId);
      return c.json(workspaceConversationsSchema.parse({ conversations: workspaceStore.conversations(workspaceId)
        .map(item => ({ ...item, ...(running?.conversationId === item.id ? { activeTurnId: running.turnId } : {}) })) }));
    })
    .post('/v1/workspaces/:workspaceId/conversations', c => {
      try { return c.json(workspaceStore.createConversation(c.req.param('workspaceId')), 201); }
      catch (error) { return c.json({ code: 'CONVERSATION_CREATE_FAILED', message: error instanceof Error ? error.message : '创建会话失败' }, 409); }
    })
    .delete('/v1/workspaces/:workspaceId/conversations/:conversationId', c => {
      const workspaceId = c.req.param('workspaceId');
      if (sourceTurns.has(workspaceId)) return c.json({ code: 'WORKSPACE_BUSY', message: '副本正在修改，请等待任务完成或先停止再删除会话' }, 409);
      try {
        const conversations = workspaceStore.deleteConversation(workspaceId, c.req.param('conversationId'));
        const next = conversations[0]!;
        return c.json({ workspaceId, conversations, entries: workspaceStore.chat(workspaceId, next.id) });
      } catch (error) {
        return c.json({ code: 'CONVERSATION_DELETE_FAILED', message: error instanceof Error ? error.message : '删除会话失败' }, 409);
      }
    })
    .get('/v1/workspaces/:workspaceId/conversation', c => {
      const workspaceId = c.req.param('workspaceId');
      try {
        return c.json(workspaceConversationResponseSchema.parse({
          workspaceId,
          entries: workspaceStore.chat(workspaceId, c.req.query('conversationId'))
        }));
      } catch (error) {
        return c.json({ code: 'WORKSPACE_CONVERSATION_NOT_FOUND', message: error instanceof Error ? error.message : '工作区不存在' }, 404);
      }
    })
    .post('/v1/workspaces/:workspaceId/conversation', zValidator('json', workspaceChatEntrySchema), c => {
      const workspaceId = c.req.param('workspaceId');
      try {
        workspaceStore.appendChat(workspaceId, c.req.valid('json'));
        return c.json(workspaceConversationResponseSchema.parse({
          workspaceId,
          entries: workspaceStore.chat(workspaceId, c.req.valid('json').conversationId)
        }), 201);
      } catch (error) {
        return c.json({ code: 'WORKSPACE_CONVERSATION_APPEND_FAILED', message: error instanceof Error ? error.message : '保存副本对话失败' }, 409);
      }
    })
    .get('/workspaces/:workspaceId/preview', c => {
      try {
        const candidate = c.req.query('candidate') === 'B' ? 'B' : 'A';
        if (candidate === 'A' && !frozenStyleVariantEnabled) return c.text(aVariantDisabledMessage, 409);
        const previewToken = c.req.query('preview_token');
        const assetQuery = previewToken ? `?preview_token=${encodeURIComponent(previewToken)}` : '';
        const html = workspaceStore.previewHtml(c.req.param('workspaceId'), candidate, assetQuery);
        if (!html) return c.text('静态源码副本不存在', 404);
        c.header('X-UI-Agent-Candidate', candidate);
        c.header('X-UI-Agent-Candidate-Label', candidate === 'B' ? 'author-rules-overlay' : 'frozen-computed-style');
        const externalSources = ' http: https:';
        c.header('Content-Security-Policy', `default-src 'none'; style-src 'self' 'unsafe-inline'${externalSources}; img-src 'self' data: blob:${externalSources}; font-src 'self' data:${externalSources}; connect-src 'none'; script-src 'self'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'`);
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
      try { workspaceStore.assertConversation(workspaceId, request.conversationId); }
      catch { return c.json({ code: 'CONVERSATION_NOT_FOUND', message: '会话不存在或不属于该副本' }, 404); }
      const admission = await sourceTurns.startPersisted(workspaceId, request.turnId, request.conversationId ?? workspaceId,
        signal => executeSourceTurn(workspaceId, request, signal), workspaceStore.persistence);
      if (admission === 'busy') return c.json({ code: 'WORKSPACE_BUSY', message: '该副本已有修改任务正在运行，请等待完成或先停止该任务' }, 409);
      return c.json(sourceTurnAcceptedSchema.parse({ kind: 'accepted', turnId: request.turnId }), 202);
    })
    .get('/v1/workspaces/:workspaceId/turns/:turnId/progress', c => {
      const progress = sourceProgress.get(c.req.param('workspaceId'), c.req.param('turnId'));
      return progress
        ? c.json(sourceTurnProgressSchema.parse(progress))
        : c.json({ code: 'TURN_PROGRESS_NOT_FOUND', message: '该 Turn 尚未开始或进度已清理' }, 404);
    })
    .post('/v1/workspaces/:workspaceId/turns/:turnId/cancel', c => {
      const workspaceId = c.req.param('workspaceId');
      const turnId = c.req.param('turnId');
      const progress = sourceProgress.get(workspaceId, turnId);
      if (!progress) return c.json({ code: 'TURN_PROGRESS_NOT_FOUND', message: '该 Turn 尚未开始或进度已清理' }, 404);
      if (progress.status !== 'running') {
        return c.json({ code: 'TURN_NOT_RUNNING', message: '本轮任务已结束，无法停止' }, 409);
      }
      if (!sourceTurns.cancel(workspaceId, turnId)) return c.json({ code: 'TURN_CANCEL_UNAVAILABLE', message: '本轮任务当前无法停止' }, 409);
      return c.json({ kind: 'cancelling', turnId }, 202);
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
