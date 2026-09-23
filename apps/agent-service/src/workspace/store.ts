import type { WorkspacePersistence } from './persistence';
import { WorkspaceRevisionHistory } from './revision-history';
import type { WorkspaceConversation } from '@ui-agent/contracts';
import { validateWorkspaceFiles } from './workspace-validation';
import { renderWorkspacePreview } from './preview';
import { createEditingSession } from './editing-session';
import { WorkspaceFileStorage } from './file-storage';
import { type WorkspaceFiles, type CapturedLayoutIndex, LAYOUT_INDEX_FILE, type WorkspaceManifest, type SourceWorkspace, type WorkspaceOwner, LOCAL_WORKSPACE_OWNER, type ManagedSourceWorkspace, type WorkspaceListOptions, type SourceWorkspaceStoreOptions } from './workspace-types';
import { compileModuleSource } from './module-compiler';
import { validateAuthorCss, cssImportSources, validateHtml, validateCss } from './source-validation';
import { extractCapturedLayoutIndex } from './source-document';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { type CodingAgentConversationTurn, type CodingWorkspaceTools } from '@ui-agent/agent-runtime';
import { PROTOCOL_VERSION, staticSnapshotSchema, authorStyleCaptureSchema, authorStyleSheetSchema, type AuthorStyleCapture, type AuthorStyleResource, type AuthorStyleSheet, type StaticSnapshot, type SourceTurnRequest, type SourceTurnResponse, type WorkspaceChatEntry } from '@ui-agent/contracts';
import { compileSourceWorkspace, refreshWorkspaceIndexes } from './compiler';

import { diagnoseSnapshotPackage, type SnapshotDiagnostics } from './snapshot-diagnostics';

export class SourceWorkspaceStore {
  private readonly storage: WorkspaceFileStorage;
  private readonly history: WorkspaceRevisionHistory;
  private readonly localRoot: string;
  persistence?: WorkspacePersistence;
  get root(): string { return this.persistence?.root ?? this.localRoot; }
  private readonly identityIsolation: boolean;
  private readonly frozenStyleVariantEnabled: boolean;
  private readonly active = new Set<string>();
  private readonly resourceLoadFailures = new Map<string, Map<number, string>>();
  // LRU bounded by estimated retained string size; never retain all workspaces.
  private readonly sheetCache = new Map<string, { signature: string; weight: number; sheets: AuthorStyleSheet[] }>();
  private sheetCacheWeight = 0;

  constructor(root = '.snapshots/source-workspaces', options: SourceWorkspaceStoreOptions = {}) {
    this.localRoot = resolve(root);
    this.storage = new WorkspaceFileStorage(() => this.root, () => !this.persistence || this.persistence.inTransaction);
    this.history = new WorkspaceRevisionHistory(this.storage);
    this.identityIsolation = options.identityIsolation ?? true;
    this.frozenStyleVariantEnabled = options.frozenStyleVariantEnabled ?? true;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  create(input: unknown, owner: WorkspaceOwner = LOCAL_WORKSPACE_OWNER): SourceWorkspace {
    if (this.persistence && !this.persistence.inTransaction) throw new Error('S3 模式必须通过提交协调层创建副本');
    const snapshot = staticSnapshotSchema.parse(input);
    if (!this.frozenStyleVariantEnabled) {
      const authorCapture = snapshot.authorStyles;
      const hasAuthorRules = Boolean(authorCapture && (
        authorCapture.cssText.trim()
        || (authorCapture.unreadableSources?.length ?? 0) > 0
        || authorCapture.sheets?.some(sheet => sheet.renderOnly || Boolean(sheet.cssText?.trim()))
      ));
      if (!hasAuthorRules) {
        throw new Error('当前页面没有可用的 B 方案样式资源，已禁用 A 方案兜底');
      }
    }
    validateHtml(snapshot.html);
    if (snapshot.authorOverrides !== undefined) validateCss(snapshot.authorOverrides);
    const compiled = compileSourceWorkspace(snapshot.html, {
      viewport: snapshot.viewport,
      preserveInlineStyles: Boolean(snapshot.authorStyles)
    });
    validateHtml(compiled.html);
    validateCss(compiled.css);
    const workspaceId = randomUUID();
    const directory = this.storage.workspacePath(workspaceId);
    const initialRevision = resolve(directory, 'revisions', '000');
    mkdirSync(initialRevision, { recursive: true, mode: 0o700 });
    const extractedLayout = extractCapturedLayoutIndex(compiled.html);
    const layoutIndex = { ...extractedLayout.layoutIndex, ...(snapshot.layoutIndex ?? {}) };
    const indexes = refreshWorkspaceIndexes(extractedLayout.html);
    const moduleSource = snapshot.moduleSource ?? '';
    const moduleJavaScript = compileModuleSource(moduleSource);
    const files: WorkspaceFiles = {
      'index.html': extractedLayout.html,
      'snapshot.css': this.frozenStyleVariantEnabled ? compiled.css : '',
      // B keeps captured author rules immutable. User/agent visual edits live
      // in this versioned layer so they can be undone without mutating capture.
      'author-overrides.css': snapshot.authorOverrides ?? '',
      'module.jsx': moduleSource,
      'module.js': moduleJavaScript,
      'outline.json': indexes.outline,
      'source-map.json': indexes.sourceMap
    };
    validateWorkspaceFiles(files);
    this.storage.writeWorkspaceFiles(directory, files);
    this.storage.writeWorkspaceFiles(initialRevision, files);
    this.storage.atomicWrite(resolve(directory, LAYOUT_INDEX_FILE), JSON.stringify(layoutIndex));
    if (snapshot.authorStyles) {
      this.storage.atomicWrite(resolve(directory, 'author.css'), snapshot.authorStyles.cssText);
      this.storage.atomicWrite(resolve(directory, 'author-resources.json'), JSON.stringify(snapshot.authorStyles.resources ?? []));
      this.storage.atomicWrite(resolve(directory, 'author-capture.json'), JSON.stringify(snapshot.authorStyles));
      this.storage.atomicWrite(resolve(directory, 'author-style-links.json'), JSON.stringify(snapshot.authorStyles.unreadableSources ?? []));
      this.storage.atomicWrite(resolve(directory, 'author-sheets.json'), JSON.stringify(snapshot.authorStyles.sheets ?? []));
    }
    const now = new Date().toISOString();
    this.storage.writeManifest(directory, {
      workspaceVersion: 2,
      workspaceId,
      ownerId: owner.userId,
      tenantId: owner.tenantId,
      title: snapshot.title,
      sourceUrl: snapshot.sourceUrl,
      selectedSourceId: snapshot.selectedSourceId,
      ...(snapshot.metrics ? { snapshotMetrics: snapshot.metrics } : {}),
      viewport: snapshot.viewport,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      maxRevision: 0,
      summaries: [{ revision: 0, summary: '初始静态副本', timestamp: now }],
      conversation: [],
      chat: []
    });
    return this.get(workspaceId)!;
  }

  get(workspaceId: string): SourceWorkspace | undefined {
    const directory = this.storage.workspacePath(workspaceId);
    if (!existsSync(resolve(directory, 'workspace.json'))) return undefined;
    const manifest = this.storage.readManifest(directory);
    if (manifest.deletedAt) return undefined;
    return this.workspaceFromManifest(manifest);
  }

  diagnostics(workspaceId: string): SnapshotDiagnostics {
    const directory = this.storage.workspacePath(workspaceId);
    if (!existsSync(resolve(directory, 'workspace.json'))) throw new Error('静态源码工作区不存在');
    const files = this.storage.readWorkspaceFiles(directory);
    return diagnoseSnapshotPackage({
      html: files['index.html'],
      css: files['snapshot.css'],
      outline: files['outline.json'],
      sourceMap: files['source-map.json'],
      authorCss: this.storage.readOptionalFile(resolve(directory, 'author.css')),
      authorResources: this.authorStyleResources(workspaceId),
      authorRenderOnlyStyleCount: this.externalAuthorStyleSources(workspaceId).length,
      authorResourceFailureCount: this.resourceLoadFailures.get(workspaceId)?.size ?? 0
    });
  }

  authorStyles(workspaceId: string): { cssText: string; available: boolean } {
    const directory = this.storage.workspacePath(workspaceId);
    if (!existsSync(resolve(directory, 'workspace.json'))) throw new Error('静态源码工作区不存在');
    const path = resolve(directory, 'author.css');
    return { cssText: this.storage.readOptionalFile(path) ?? '', available: existsSync(path) };
  }

  authorCss(workspaceId: string): string | undefined {
    const styles = this.authorStyles(workspaceId);
    if (!styles.available || !styles.cssText) return undefined;
    validateAuthorCss(styles.cssText, this.authorStyleResources(workspaceId));
    return styles.cssText;
  }

  /**
   * These are stylesheet URLs the browser can apply but the capture pipeline
   * could not inspect. They are deliberately kept separate from author.css:
   * rendering may use them, but an Agent must not treat them as observable or
   * editable source rules.
   */
  unreadableAuthorStyleSources(workspaceId: string): string[] {
    const raw = this.storage.readOptionalFile(resolve(this.storage.workspacePath(workspaceId), 'author-style-links.json'));
    if (!raw) return [];
    try {
      const sources = JSON.parse(raw) as unknown;
      return Array.isArray(sources)
        ? [...new Set(sources.filter((source): source is string => typeof source === 'string' && /^https?:\/\//i.test(source)))]
        : [];
    } catch {
      return [];
    }
  }

  hasAuthorRuleCandidate(workspaceId: string): boolean {
    const sheets = this.authorStyleSheets(workspaceId);
    return Boolean(this.authorCss(workspaceId))
      || this.unreadableAuthorStyleSources(workspaceId).length > 0
      || sheets.some(sheet => sheet.renderOnly || Boolean(sheet.cssText?.trim()));
  }

  isFrozenStyleVariantEnabled(): boolean {
    return this.frozenStyleVariantEnabled;
  }

  private externalAuthorStyleSources(workspaceId: string): string[] {
    const sheets = this.authorStyleSheets(workspaceId);
    const sources = sheets
      .filter(sheet => sheet.renderOnly)
      .map(sheet => sheet.sourceUrl);
    // Match previewHtml's choice of per-sheet links versus legacy author.css.
    // Old workspaces have no sheet manifest but can still contain @import.
    const cssTexts = sheets.length
      ? sheets.filter(sheet => !sheet.renderOnly).map(sheet => sheet.cssText ?? '')
      : [this.authorStyles(workspaceId).cssText];
    const imports = cssTexts.flatMap(css => cssImportSources(css.replace(/\/\*[\s\S]*?\*\//g, '')));
    return [...new Set([...(sheets.length ? sources : this.unreadableAuthorStyleSources(workspaceId)), ...imports])];
  }

  externalAuthorStyleOrigins(workspaceId: string): string[] {
    return [...new Set(this.externalAuthorStyleSources(workspaceId).flatMap(source => {
      try {
        const url = new URL(source);
        return /^https?:$/.test(url.protocol) ? [url.origin] : [];
      } catch { return []; }
    }))];
  }

  authorStyleSheets(workspaceId: string): AuthorStyleSheet[] {
    const path = resolve(this.storage.workspacePath(workspaceId), 'author-sheets.json');
    try {
      const stat = statSync(path);
      const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = this.sheetCache.get(path);
      if (cached?.signature === signature) {
        this.sheetCache.delete(path);
        this.sheetCache.set(path, cached);
        return cached.sheets;
      }
      this.evictSheetCache(path);
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const result = authorStyleSheetSchema.array().safeParse(parsed);
      if (!result.success) return [];
      const weight = raw.length * 2 + result.data.length * 1024;
      const budget = 32 * 1024 * 1024;
      if (weight <= budget) {
        while (this.sheetCache.size && (this.sheetCacheWeight + weight > budget || this.sheetCache.size >= 32)) {
          this.evictSheetCache(this.sheetCache.keys().next().value!);
        }
        this.sheetCache.set(path, { signature, weight, sheets: result.data });
        this.sheetCacheWeight += weight;
      }
      return result.data;
    } catch {
      this.evictSheetCache(path);
      return [];
    }
  }

  private evictSheetCache(path: string): void {
    const cached = this.sheetCache.get(path);
    if (cached) this.sheetCacheWeight -= cached.weight;
    this.sheetCache.delete(path);
  }

  authorOverrides(workspaceId: string): string {
    const directory = this.storage.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const css = this.storage.readOptionalFile(resolve(directory, 'author-overrides.css')) ?? '';
    validateCss(css);
    return css;
  }

  /** Captured CSS already contains absolute resource URLs; let the browser load them. */
  authorCssForPreview(workspaceId: string, _assetQuery = ''): string | undefined {
    const css = this.authorCss(workspaceId);
    if (!css) return undefined;
    return css;
  }

  authorStyleSheetCssForPreview(workspaceId: string, index: number, _assetQuery = ''): string | undefined {
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    const sheet = this.authorStyleSheets(workspaceId)[index];
    if (!sheet || sheet.renderOnly || sheet.cssText === undefined) return undefined;
    // validateAuthorCss does not consume the resource list; avoid rereading it per sheet.
    validateAuthorCss(sheet.cssText, []);
    return sheet.cssText;
  }

  authorStyleResource(workspaceId: string, index: number): AuthorStyleResource | undefined {
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    return this.authorStyleResources(workspaceId)[index];
  }

  recordAuthorResourceFailure(workspaceId: string, index: number, reason: string): void {
    if (!this.authorStyleResource(workspaceId, index)) return;
    const failures = this.resourceLoadFailures.get(workspaceId) ?? new Map<number, string>();
    failures.set(index, reason.slice(0, 300));
    this.resourceLoadFailures.set(workspaceId, failures);
  }

  clearAuthorResourceFailure(workspaceId: string, index: number): void {
    const failures = this.resourceLoadFailures.get(workspaceId);
    if (!failures) return;
    failures.delete(index);
    if (failures.size === 0) this.resourceLoadFailures.delete(workspaceId);
  }

  authorStyleResources(workspaceId: string): AuthorStyleResource[] {
    const directory = this.storage.workspacePath(workspaceId);
    const raw = this.storage.readOptionalFile(resolve(directory, 'author-resources.json'));
    if (!raw) return [];
    try {
      const resources = JSON.parse(raw) as AuthorStyleResource[];
      return resources.filter(resource => /^https?:\/\//i.test(resource.url) && /^https?:\/\//i.test(resource.sourceUrl));
    } catch {
      return [];
    }
  }

  authorStyleCapture(workspaceId: string): AuthorStyleCapture | undefined {
    const raw = this.storage.readOptionalFile(resolve(this.storage.workspacePath(workspaceId), 'author-capture.json'));
    if (!raw) return undefined;
    try {
      const parsed = authorStyleCaptureSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  list(
    options: WorkspaceListOptions = {},
    owner: WorkspaceOwner = LOCAL_WORKSPACE_OWNER
  ): { items: ManagedSourceWorkspace[]; total: number; offset: number; limit: number } {
    const query = options.query?.trim().toLocaleLowerCase() ?? '';
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(100, Math.max(1, options.limit ?? 30));
    const items = readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
      .flatMap(entry => {
        const directory = this.storage.workspacePath(entry.name);
        if (!existsSync(resolve(directory, 'workspace.json'))) return [];
        try {
          const manifest = this.storage.readManifest(directory);
          if (!this.manifestBelongsTo(manifest, owner)) return [];
          // Old soft-deleted data stays hidden until explicitly cleaned up.
          if (manifest.deletedAt) return [];
          if (query && !`${manifest.title}\n${manifest.sourceUrl}`.toLocaleLowerCase().includes(query)) return [];
          return [this.workspaceFromManifest(manifest)];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
  }

  owns(workspaceId: string, owner: WorkspaceOwner): boolean {
    const directory = this.storage.workspacePath(workspaceId);
    if (!existsSync(resolve(directory, 'workspace.json'))) return false;
    try {
      return this.manifestBelongsTo(this.storage.readManifest(directory), owner);
    } catch {
      return false;
    }
  }

  rename(workspaceId: string, title: string): ManagedSourceWorkspace {
    const normalized = title.trim();
    if (!normalized || normalized.length > 200) throw new Error('副本名称长度必须为 1-200 个字符');
    const directory = this.storage.workspacePath(workspaceId);
    const manifest = this.storage.readManifest(directory);
    if (manifest.deletedAt) throw new Error('副本已删除');
    const updated = { ...manifest, title: normalized, updatedAt: new Date().toISOString() };
    this.storage.writeManifest(directory, updated);
    return this.workspaceFromManifest(updated);
  }

  deleteWorkspace(workspaceId: string): void {
    if (this.active.has(workspaceId)) throw new Error('Agent 修改执行期间不能删除副本');
    const directory = this.storage.workspacePath(workspaceId);
    this.storage.deleteWorkspace(workspaceId);
    this.evictSheetCache(resolve(directory, 'author-sheets.json'));
    this.resourceLoadFailures.delete(workspaceId);
  }

  html(workspaceId: string): string | undefined {
    const path = resolve(this.storage.workspacePath(workspaceId), 'index.html');
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }

  exportSnapshot(workspaceId: string): StaticSnapshot | undefined {
    const directory = this.storage.workspacePath(workspaceId);
    const manifestPath = resolve(directory, 'workspace.json');
    if (!existsSync(manifestPath)) return undefined;
    const manifest = this.storage.readManifest(directory);
    if (manifest.deletedAt) return undefined;
    const html = this.storage.readOptionalFile(resolve(directory, 'index.html'));
    if (!html) return undefined;
    const css = this.storage.readOptionalFile(resolve(directory, 'snapshot.css')) ?? '';
    const style = `<style data-ui-agent-workspace-styles>\n${css}\n</style>`;
    const withStyles = /<\/head>/i.test(html)
      ? html.replace(/<\/head>/i, `${style}\n</head>`)
      : /<body\b/i.test(html)
        ? html.replace(/<body\b/i, `${style}\n<body`)
        : html;
    const nodeCount = (withStyles.match(/\bdata-ui-source-id\s*=\s*["']/gi) ?? []).length;
    const authorCss = this.storage.readOptionalFile(resolve(directory, 'author.css'));
    const authorResources = this.authorStyleResources(workspaceId);
    const authorCapture = this.authorStyleCapture(workspaceId);
    const authorSheets = this.authorStyleSheets(workspaceId);
    const authorOverrides = this.storage.readOptionalFile(resolve(directory, 'author-overrides.css')) ?? '';
    const moduleSource = readFileSync(resolve(directory, 'module.jsx'), 'utf8');
    return {
      protocolVersion: PROTOCOL_VERSION,
      title: manifest.title,
      sourceUrl: manifest.sourceUrl,
      capturedAt: manifest.createdAt,
      html: extractCapturedLayoutIndex(withStyles).html,
      nodeCount: Math.max(1, nodeCount),
      selectedSourceId: manifest.selectedSourceId,
      ...(manifest.snapshotMetrics ? { metrics: manifest.snapshotMetrics } : {}),
      ...(this.hasAuthorRuleCandidate(workspaceId) ? {
        authorStyles: {
          cssText: authorCss ?? '',
          readableSheets: authorCapture?.readableSheets ?? manifest.snapshotMetrics?.authorReadableSheets ?? 0,
          unreadableSheets: authorCapture?.unreadableSheets ?? manifest.snapshotMetrics?.authorUnreadableSheets ?? 0,
          missing: authorCapture?.missing ?? manifest.snapshotMetrics?.authorMissingSources ?? [],
          sources: authorCapture?.sources,
          unreadableSources: this.unreadableAuthorStyleSources(workspaceId),
          sheets: authorSheets.length ? authorSheets : undefined,
          resources: authorResources
        },
        authorStyleSources: authorCapture?.sources ?? authorResources.map(resource => resource.sourceUrl).filter((value, index, values) => values.indexOf(value) === index)
      } : {}),
      ...(authorOverrides ? { authorOverrides } : {}),
      ...(moduleSource ? { moduleSource } : {}),
      layoutIndex: this.capturedLayoutIndex(workspaceId),
      viewport: manifest.viewport ?? { width: 1440, height: 900 }
    };
  }

  exportActiveSnapshots(owner: WorkspaceOwner = LOCAL_WORKSPACE_OWNER): StaticSnapshot[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
      .flatMap(entry => {
        const directory = this.storage.workspacePath(entry.name);
        if (!existsSync(resolve(directory, 'workspace.json'))) return [];
        try {
          const manifest = this.storage.readManifest(directory);
          if (manifest.deletedAt || !this.manifestBelongsTo(manifest, owner)) return [];
          const snapshot = this.exportSnapshot(entry.name);
          return snapshot ? [{ snapshot, updatedAt: manifest.updatedAt }] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(item => item.snapshot);
  }

  moduleJavaScript(workspaceId: string): string | undefined {
    if (!this.get(workspaceId)) return undefined;
    const directory = this.storage.workspacePath(workspaceId);
    return readFileSync(resolve(directory, 'module.js'), 'utf8');
  }

  previewHtml(workspaceId: string, candidate: 'A' | 'B' = 'A', assetQuery = ''): string | undefined {
    if (!this.get(workspaceId)) return undefined;
    if (candidate === 'A' && !this.frozenStyleVariantEnabled) return undefined;
    const directory = this.storage.workspacePath(workspaceId);
    return this.previewHtmlFromFiles(workspaceId, this.storage.readWorkspaceFiles(directory), candidate, assetQuery);
  }

  private previewHtmlFromFiles(
    workspaceId: string, files: WorkspaceFiles, candidate: 'A' | 'B', assetQuery: string,
    workspaceAssetPath = ''
  ): string | undefined {
    return renderWorkspacePreview({
      files, candidate, assetQuery, workspaceAssetPath,
      authorResources: this.authorStyleResources(workspaceId),
      unreadableStyleSources: this.unreadableAuthorStyleSources(workspaceId),
      authorSheets: this.authorStyleSheets(workspaceId),
      authorCss: this.authorCss(workspaceId),
      authorRulesAvailable: this.hasAuthorRuleCandidate(workspaceId)
    });
  }

  conversations(workspaceId: string): WorkspaceConversation[] {
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const manifest = this.storage.readManifest(this.storage.workspacePath(workspaceId));
    const previews = new Map<string, string>();
    for (const entry of manifest.chat ?? []) {
      if (entry.text.trim()) previews.set(entry.conversationId ?? workspaceId, entry.text.replace(/\s+/g, ' ').slice(0, 160));
    }
    const conversations = manifest.conversations ?? [{ id: workspaceId, title: manifest.chat?.find(entry => entry.role === 'user')?.text.slice(0, 40) ?? '新会话',
      createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, lastRevision: manifest.revision }];
    return conversations.map(conversation => ({ ...conversation, preview: previews.get(conversation.id) }));
  }

  createConversation(workspaceId: string) {
    const conversations = this.conversations(workspaceId);
    if (conversations.length >= 100) throw new Error('该副本已达到 100 个会话上限，请新建副本继续');
    const directory = this.storage.workspacePath(workspaceId);
    const manifest = this.storage.readManifest(directory);
    const now = new Date().toISOString();
    const conversation = { id: randomUUID(), title: '新会话', createdAt: now, updatedAt: now, lastRevision: manifest.revision };
    this.storage.writeManifest(directory, { ...manifest, conversations: [...conversations, conversation] });
    return conversation;
  }

  assertConversation(workspaceId: string, conversationId = workspaceId): void {
    if (!this.conversations(workspaceId).some(item => item.id === conversationId)) throw new Error('会话不存在或不属于该副本');
  }

  deleteConversation(workspaceId: string, conversationId: string) {
    this.assertConversation(workspaceId, conversationId);
    if (this.active.has(workspaceId)) throw new Error('副本正在修改，请等待任务完成或先停止再删除会话');
    const directory = this.storage.workspacePath(workspaceId);
    const manifest = this.storage.readManifest(directory);
    const now = new Date().toISOString();
    const conversations = this.conversations(workspaceId).filter(item => item.id !== conversationId);
    if (!conversations.length) conversations.push({ id: randomUUID(), title: '新会话',
      createdAt: now, updatedAt: now, lastRevision: manifest.revision });
    // Delete only conversation data. Page files, revisions and diagnostic logs are untouched.
    this.storage.writeManifest(directory, { ...manifest, conversations,
      chat: (manifest.chat ?? []).filter(entry => (entry.conversationId ?? workspaceId) !== conversationId),
      conversation: (manifest.conversation ?? []).filter(turn => (turn.conversationId ?? workspaceId) !== conversationId)
    });
    return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  conversation(workspaceId: string, conversationId = workspaceId): CodingAgentConversationTurn[] {
    this.assertConversation(workspaceId, conversationId);
    const directory = this.storage.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const manifest = this.storage.readManifest(directory);
    return (manifest.conversation ?? [])
      .filter(turn => (turn.conversationId ?? workspaceId) === conversationId)
      .filter(turn => (turn.revision ?? 0) <= manifest.revision)
      .slice(-8)
      .map(({ instruction, result }) => ({ instruction, result }));
  }

  chat(workspaceId: string, conversationId = workspaceId): WorkspaceChatEntry[] {
    this.assertConversation(workspaceId, conversationId);
    const directory = this.storage.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const manifest = this.storage.readManifest(directory);
    return (manifest.chat ?? [])
      .filter(entry => (entry.conversationId ?? workspaceId) === conversationId)
      .slice(-200);
  }

  appendChat(workspaceId: string, entry: WorkspaceChatEntry): void {
    const conversationId = entry.conversationId ?? workspaceId;
    this.assertConversation(workspaceId, conversationId);
    const conversations = this.conversations(workspaceId);
    const directory = this.storage.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const manifest = this.storage.readManifest(directory);
    if (entry.revision > manifest.revision) {
      throw new Error('对话记录不能关联到尚未生成的副本版本');
    }
    if ((manifest.chat ?? []).some(item => item.id === entry.id)) return;
    this.storage.writeManifest(directory, {
      ...manifest,
      updatedAt: new Date().toISOString(),
      conversations: conversations.map(item => item.id === conversationId ? { ...item,
        title: entry.role === 'user' && !manifest.chat?.some(previous => previous.role === 'user'
          && (previous.conversationId ?? workspaceId) === conversationId) ? entry.text.slice(0, 40) : item.title,
        updatedAt: entry.createdAt, lastRevision: entry.revision } : item),
      chat: [...(manifest.chat ?? []).filter(item => (item.conversationId ?? workspaceId) !== conversationId),
        ...[...(manifest.chat ?? []).filter(item => (item.conversationId ?? workspaceId) === conversationId), entry].slice(-200)]
    });
  }

  recordTurn(workspaceId: string, request: SourceTurnRequest, response: SourceTurnResponse): void {
    const conversationId = request.conversationId ?? workspaceId;
    const directory = this.storage.workspacePath(workspaceId);
    const manifest = this.storage.readManifest(directory);
    if (response.kind === 'failed' || response.kind === 'cancelled') return;
    const result = response.kind === 'completed' ? response.summary : response.question;
    const revision = response.kind === 'completed' ? response.revision : manifest.revision;
    const retained = response.kind === 'completed'
      ? (manifest.conversation ?? []).filter(turn => (turn.conversationId ?? workspaceId) !== conversationId || (turn.revision ?? 0) < response.revision)
      : (manifest.conversation ?? []);
    const linked = response.kind === 'completed'
      ? retained.map(turn => (turn.conversationId ?? workspaceId) === conversationId && turn.pending && (
        request.replyToClarificationId
          ? turn.clarificationId === request.replyToClarificationId
          : turn.revision === response.revision - 1
      )
        ? { ...turn, revision: response.revision, pending: false }
        : turn)
      : retained;
    this.storage.writeManifest(directory, {
      ...manifest,
      updatedAt: new Date().toISOString(),
      chat: response.kind === 'completed'
        ? (manifest.chat ?? []).map(entry => {
          if ((entry.conversationId ?? workspaceId) !== conversationId) return entry;
          if (entry.id === request.turnId || (request.replyToClarificationId && entry.id === request.replyToClarificationId)) {
            return { ...entry, revision: response.revision };
          }
          if (request.replyToClarificationId && entry.clarification?.clarificationId === request.replyToClarificationId) {
            return {
                ...entry,
                revision: response.revision,
                clarification: { ...entry.clarification, resolved: true }
              };
          }
          return entry;
        })
        : manifest.chat,
      conversations: this.conversations(workspaceId).map(item => item.id === conversationId
        ? { ...item, updatedAt: new Date().toISOString(), lastRevision: revision } : item),
      conversation: [
        ...linked,
        {
          conversationId,
          instruction: request.instruction,
          result,
          revision,
          ...(request.replyToClarificationId && {
            replyToClarificationId: request.replyToClarificationId
          }),
          ...(request.clarificationOptionId && {
            clarificationOptionId: request.clarificationOptionId
          }),
          ...(response.kind === 'clarification' && {
            pending: true,
            clarificationId: response.clarificationId ?? request.turnId
          })
        }
      ].filter((turn, index, turns) => (turn.conversationId ?? workspaceId) !== conversationId
        || turns.slice(index).filter(item => (item.conversationId ?? workspaceId) === conversationId).length <= 40)
    });
  }

  tools(workspaceId: string): CodingWorkspaceTools {
    const workspaceDirectory = this.storage.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    if (this.active.has(workspaceId)) throw new Error('当前工作区已有正在执行的修改');
    const directory = workspaceDirectory;
    this.active.add(workspaceId);
    try {
      const original = this.storage.readWorkspaceFiles(directory);
      const authorRuleMode = this.hasAuthorRuleCandidate(workspaceId);
      return createEditingSession({
        original,
        initial: this.storage.readWorkspaceFiles(resolve(workspaceDirectory, 'revisions', '000')),
        authorRuleMode,
        authorCssContent: authorRuleMode ? this.authorCss(workspaceId) ?? '' : '',
        unreadableStyleSources: this.unreadableAuthorStyleSources(workspaceId),
        layoutIndex: () => this.capturedLayoutIndex(workspaceId),
        currentRevision: () => this.storage.readManifest(workspaceDirectory).revision,
        commit: (files, summary) => this.commitWorkingCopy(workspaceId, files, summary),
        release: () => { this.active.delete(workspaceId); }
      });
    } catch (error) {
      this.active.delete(workspaceId);
      throw error;
    }
  }

  undo(workspaceId: string): SourceWorkspace {
    return this.restore(workspaceId, -1);
  }

  redo(workspaceId: string): SourceWorkspace {
    return this.restore(workspaceId, 1);
  }

  reset(workspaceId: string): SourceWorkspace {
    if (this.active.has(workspaceId)) throw new Error('Agent 修改执行期间不能恢复初始版本');
    const current = this.get(workspaceId);
    if (!current) throw new Error('静态源码工作区不存在');
    if (current.revision === 0) return current;
    this.history.reset(workspaceId);
    return this.get(workspaceId)!;
  }

  private commitWorkingCopy(workspaceId: string, files: WorkspaceFiles, summary: string): number {
    return this.history.commit(workspaceId, files, summary);
  }

  private restore(workspaceId: string, direction: -1 | 1): SourceWorkspace {
    if (this.active.has(workspaceId)) throw new Error('Agent 修改执行期间不能撤销或重做');
    this.history.restore(workspaceId, direction);
    return this.get(workspaceId)!;
  }

  private capturedLayoutIndex(workspaceId: string): CapturedLayoutIndex {
    const stored = readFileSync(resolve(this.storage.workspacePath(workspaceId), LAYOUT_INDEX_FILE), 'utf8');
    return staticSnapshotSchema.shape.layoutIndex.parse(JSON.parse(stored)) ?? {};
  }

  private workspaceFromManifest(manifest: WorkspaceManifest): ManagedSourceWorkspace {
    return {
      workspaceId: manifest.workspaceId,
      title: manifest.title,
      sourceUrl: manifest.sourceUrl,
      selectedSourceId: manifest.selectedSourceId,
      revision: manifest.revision,
      canUndo: manifest.revision > 0,
      canRedo: manifest.revision < manifest.maxRevision,
      ...(manifest.snapshotMetrics ? { snapshotMetrics: manifest.snapshotMetrics } : {}),
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      ...(manifest.deletedAt && { deletedAt: manifest.deletedAt })
    };
  }

  private manifestBelongsTo(manifest: WorkspaceManifest, owner: WorkspaceOwner): boolean {
    if (!this.identityIsolation) return true;
    const ownerId = manifest.ownerId ?? LOCAL_WORKSPACE_OWNER.userId;
    const tenantId = manifest.tenantId ?? LOCAL_WORKSPACE_OWNER.tenantId;
    return ownerId === owner.userId && tenantId === owner.tenantId;
  }

}

export type { SourceWorkspace, WorkspaceOwner, ManagedSourceWorkspace, WorkspaceListOptions, SourceWorkspaceStoreOptions } from './workspace-types';
