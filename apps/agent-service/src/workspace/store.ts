import { WorkspaceRevisionHistory } from './revision-history';
import { validateWorkspaceFiles } from './workspace-validation';
import { renderWorkspacePreview } from './preview';
import { createEditingSession } from './editing-session';
import { WorkspaceFileStorage } from './file-storage';
import { WORKSPACE_FILES, type WorkspaceFiles, type CapturedLayoutIndex, LAYOUT_INDEX_FILE, type CandidateManifest, type WorkspaceManifest, type SourceWorkspace, type WorkspaceOwner, LOCAL_WORKSPACE_OWNER, type ManagedSourceWorkspace, type WorkspaceListOptions, type SourceWorkspaceStoreOptions } from './workspace-types';
import { compileModuleSource } from './module-compiler';
import { validateAuthorCss, cssImportSources, validateHtml, validateCss } from './source-validation';
import { escapeHtmlAttribute, extractCapturedLayoutIndex } from './source-document';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { type CodingAgentConversationTurn, type CodingWorkspaceTools } from '@ui-agent/agent-runtime';
import { PROTOCOL_VERSION, staticSnapshotSchema, authorStyleCaptureSchema, authorStyleSheetSchema, candidateObservationRequestSchema, candidateGeometryValidationRequestSchema, renderArtifactRequestSchema, workspaceIntentSchema, validationRecordRequestSchema, candidatePublishRequestSchema, type AuthorStyleCapture, type AuthorStyleResource, type AuthorStyleSheet, type StaticSnapshot, type WorkspaceCandidate, type CandidateObservation, type RenderArtifact, type LiveWorkspaceObservation, type WorkspaceIntent, type ValidationRecord, type CandidatePublishResult, type SourceTurnRequest, type SourceTurnResponse, type WorkspaceChatEntry } from '@ui-agent/contracts';
import { compileSourceWorkspace, refreshWorkspaceIndexes } from './compiler';

import { diagnoseSnapshotPackage, type SnapshotDiagnostics } from './snapshot-diagnostics';

export class SourceWorkspaceStore {
  private readonly storage: WorkspaceFileStorage;
  private readonly history: WorkspaceRevisionHistory;
  private readonly root: string;
  private readonly identityIsolation: boolean;
  private readonly frozenStyleVariantEnabled: boolean;
  private readonly active = new Set<string>();
  private readonly resourceLoadFailures = new Map<string, Map<number, string>>();
  // LRU bounded by estimated retained string size; never retain all workspaces.
  private readonly sheetCache = new Map<string, { signature: string; weight: number; sheets: AuthorStyleSheet[] }>();
  private sheetCacheWeight = 0;

  constructor(root = '.snapshots/source-workspaces', options: SourceWorkspaceStoreOptions = {}) {
    this.root = resolve(root);
    this.storage = new WorkspaceFileStorage(this.root);
    this.history = new WorkspaceRevisionHistory(this.storage);
    this.identityIsolation = options.identityIsolation ?? true;
    this.frozenStyleVariantEnabled = options.frozenStyleVariantEnabled ?? true;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  create(input: unknown, owner: WorkspaceOwner = LOCAL_WORKSPACE_OWNER): SourceWorkspace {
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
    const status = options.status ?? 'active';
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
          if (status === 'active' && manifest.deletedAt) return [];
          if (status === 'trashed' && !manifest.deletedAt) return [];
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
    if (manifest.deletedAt) throw new Error('回收站中的副本不能重命名');
    const updated = { ...manifest, title: normalized, updatedAt: new Date().toISOString() };
    this.storage.writeManifest(directory, updated);
    return this.workspaceFromManifest(updated);
  }

  trash(workspaceId: string): ManagedSourceWorkspace {
    if (this.active.has(workspaceId)) throw new Error('Agent 修改执行期间不能删除副本');
    const directory = this.storage.workspacePath(workspaceId);
    const manifest = this.storage.readManifest(directory);
    const deletedAt = manifest.deletedAt ?? new Date().toISOString();
    const updated = { ...manifest, deletedAt, updatedAt: deletedAt };
    this.storage.writeManifest(directory, updated);
    return this.workspaceFromManifest(updated);
  }

  restoreWorkspace(workspaceId: string): ManagedSourceWorkspace {
    const directory = this.storage.workspacePath(workspaceId);
    const manifest = this.storage.readManifest(directory);
    const { deletedAt: _deletedAt, ...retained } = manifest;
    const updated = { ...retained, updatedAt: new Date().toISOString() };
    this.storage.writeManifest(directory, updated);
    return this.workspaceFromManifest(updated);
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

  createCandidate(workspaceId: string, baseRevision?: number): WorkspaceCandidate {
    const workspace = this.get(workspaceId);
    if (!workspace) throw new Error('静态源码工作区不存在');
    if (this.active.has(workspaceId)) throw new Error('当前工作区已有正在执行的修改，不能创建候选');
    const revision = baseRevision ?? workspace.revision;
    const sourceDirectory = resolve(this.storage.workspacePath(workspaceId), 'revisions', String(revision).padStart(3, '0'));
    if (revision < 0 || !existsSync(resolve(sourceDirectory, 'index.html'))) throw new Error('候选基线版本不存在');
    const files = this.storage.readWorkspaceFiles(sourceDirectory);
    validateWorkspaceFiles(files);
    const candidateId = randomUUID();
    const candidateDirectory = resolve(this.storage.workspacePath(workspaceId), 'candidates', candidateId, 'versions', '000');
    mkdirSync(candidateDirectory, { recursive: true, mode: 0o700 });
    this.storage.writeWorkspaceFiles(candidateDirectory, files);
    const hasAuthorRules = this.hasAuthorRuleCandidate(workspaceId);
    if (!hasAuthorRules && !this.frozenStyleVariantEnabled) {
      throw new Error('当前副本没有可用的 B 方案样式资源，已禁用 A 方案兜底');
    }
    const manifest: CandidateManifest = {
      workspaceId,
      baseRevision: revision,
      candidateId,
      candidateVersion: 0,
      contentHash: this.contentHash(workspaceId, files),
      renderMode: hasAuthorRules ? 'B' : 'A',
      createdAt: new Date().toISOString(),
      status: 'active',
      repairAttempts: 0
    };
    this.storage.atomicWrite(resolve(this.storage.workspacePath(workspaceId), 'candidates', candidateId, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  candidate(workspaceId: string, candidateId: string, candidateVersion: number): WorkspaceCandidate | undefined {
    if (!this.get(workspaceId) || !this.isSafeCandidateId(candidateId) || !Number.isSafeInteger(candidateVersion) || candidateVersion < 0) return undefined;
    const root = resolve(this.storage.workspacePath(workspaceId), 'candidates', candidateId);
    const raw = this.storage.readOptionalFile(resolve(root, 'manifest.json'));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<CandidateManifest>;
      // Candidates created before renderMode became part of the immutable
      // document identity remain usable as the conservative frozen-style mode.
      const manifest: CandidateManifest = {
        ...parsed,
        renderMode: parsed.renderMode === 'B' ? 'B' : 'A',
        repairAttempts: Number.isSafeInteger(parsed.repairAttempts) && (parsed.repairAttempts ?? 0) >= 0
          ? parsed.repairAttempts!
          : 0
      } as CandidateManifest;
      if (manifest.workspaceId !== workspaceId || manifest.candidateId !== candidateId || manifest.candidateVersion !== candidateVersion) return undefined;
      const files = this.storage.readWorkspaceFiles(resolve(root, 'versions', String(candidateVersion).padStart(3, '0')));
      if (this.contentHash(workspaceId, files) !== manifest.contentHash) return undefined;
      return manifest;
    } catch {
      return undefined;
    }
  }

  /**
   * Reserve one repair budget before asking the model to change a candidate.
   * The reservation is durable so retries, duplicate requests, or a process
   * failure cannot create an unbounded correction loop.
   */
  reserveCandidateRepair(workspaceId: string, candidateId: string, candidateVersion: number, maxAttempts = 2): { candidate: WorkspaceCandidate; attempt: number } | undefined {
    const candidate = this.candidate(workspaceId, candidateId, candidateVersion);
    if (!candidate || candidate.status !== 'active') return undefined;
    const path = resolve(this.storage.workspacePath(workspaceId), 'candidates', candidateId, 'manifest.json');
    const raw = this.storage.readOptionalFile(path);
    if (!raw) return undefined;
    try {
      const manifest = JSON.parse(raw) as CandidateManifest;
      const attempts = Number.isSafeInteger(manifest.repairAttempts) && manifest.repairAttempts >= 0
        ? manifest.repairAttempts
        : 0;
      if (attempts >= maxAttempts) return undefined;
      const nextAttempt = attempts + 1;
      this.storage.atomicWrite(path, JSON.stringify({ ...manifest, repairAttempts: nextAttempt }, null, 2));
      return { candidate, attempt: nextAttempt };
    } catch {
      return undefined;
    }
  }

  /**
   * Persist a complete, validated next candidate version. The caller must have
   * produced `files` through controlled workspace tools; this method owns the
   * compare-and-swap and is the single point that invalidates prior evidence.
   */
  updateCandidateFiles(workspaceId: string, candidateId: string, expectedVersion: number, files: WorkspaceFiles): WorkspaceCandidate {
    const current = this.candidate(workspaceId, candidateId, expectedVersion);
    if (!current || current.status !== 'active') throw new Error('候选版本已变化，拒绝写入');
    validateWorkspaceFiles(files);
    const nextVersion = expectedVersion + 1;
    const root = resolve(this.storage.workspacePath(workspaceId), 'candidates', candidateId);
    const destination = resolve(root, 'versions', String(nextVersion).padStart(3, '0'));
    if (existsSync(destination)) throw new Error('候选下一版本已存在，拒绝覆盖');
    this.storage.writeWorkspaceFiles(destination, files);
    const next: CandidateManifest = {
      ...current,
      candidateVersion: nextVersion,
      contentHash: this.contentHash(workspaceId, files),
      createdAt: new Date().toISOString(),
      status: 'active',
      repairAttempts: (current as CandidateManifest).repairAttempts ?? 0
    };
    this.storage.atomicWrite(resolve(root, 'manifest.json'), JSON.stringify(next, null, 2));
    return next;
  }

  candidatePreviewHtml(
    workspaceId: string,
    candidateId: string,
    candidateVersion: number,
    assetQuery = '',
    workspaceAssetPath = '',
    candidateAssetPath = workspaceAssetPath
  ): string | undefined {
    const manifest = this.candidate(workspaceId, candidateId, candidateVersion);
    if (!manifest || manifest.status !== 'active') return undefined;
    if (manifest.renderMode === 'A' && !this.frozenStyleVariantEnabled) return undefined;
    const files = this.storage.readWorkspaceFiles(resolve(this.storage.workspacePath(workspaceId), 'candidates', candidateId, 'versions', String(candidateVersion).padStart(3, '0')));
    const preview = this.previewHtmlFromFiles(workspaceId, files, manifest.renderMode, assetQuery, workspaceAssetPath, candidateAssetPath);
    if (!preview) return undefined;
    const marker = `<meta name="ui-agent-document-ref" data-workspace-id="${escapeHtmlAttribute(manifest.workspaceId)}" data-candidate-id="${escapeHtmlAttribute(manifest.candidateId)}" data-candidate-version="${manifest.candidateVersion}" data-content-hash="${escapeHtmlAttribute(manifest.contentHash)}" data-render-mode="${manifest.renderMode}">`;
    return /<\/head>/i.test(preview) ? preview.replace(/<\/head>/i, `${marker}\n</head>`) : `${marker}\n${preview}`;
  }

  candidateAuthorOverrides(workspaceId: string, candidateId: string, candidateVersion: number): string | undefined {
    const manifest = this.candidate(workspaceId, candidateId, candidateVersion);
    if (!manifest || manifest.status !== 'active') return undefined;
    const css = this.storage.readOptionalFile(resolve(
      this.storage.workspacePath(workspaceId), 'candidates', candidateId, 'versions', String(candidateVersion).padStart(3, '0'), 'author-overrides.css'
    ));
    if (css === undefined) return undefined;
    validateCss(css);
    return css;
  }

  moduleJavaScript(workspaceId: string): string | undefined {
    if (!this.get(workspaceId)) return undefined;
    const directory = this.storage.workspacePath(workspaceId);
    return readFileSync(resolve(directory, 'module.js'), 'utf8');
  }

  candidateModuleJavaScript(workspaceId: string, candidateId: string, candidateVersion: number): string | undefined {
    const manifest = this.candidate(workspaceId, candidateId, candidateVersion);
    if (!manifest || manifest.status !== 'active') return undefined;
    const directory = resolve(
      this.storage.workspacePath(workspaceId),
      'candidates', candidateId, 'versions', String(candidateVersion).padStart(3, '0')
    );
    return readFileSync(resolve(directory, 'module.js'), 'utf8');
  }

  recordCandidateObservation(input: unknown): CandidateObservation {
    const request = candidateObservationRequestSchema.parse(input);
    const candidate = this.candidate(request.workspaceId, request.candidateId, request.candidateVersion);
    if (!candidate || candidate.status !== 'active') throw new Error('候选版本不存在或已失效');
    if (candidate.baseRevision !== request.baseRevision || candidate.contentHash !== request.contentHash || candidate.renderMode !== request.renderMode) {
      throw new Error('候选版本已变化，拒绝写入过期观察结果');
    }
    const observation: CandidateObservation = {
      ...request,
      observationId: randomUUID(),
      recordedAt: new Date().toISOString()
    };
    const directory = resolve(this.storage.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'observations');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.storage.atomicWrite(resolve(directory, `${observation.observationId}.json`), JSON.stringify(observation));
    return observation;
  }

  recordIntent(workspaceId: string, candidateId: string, candidateVersion: number, input: unknown): WorkspaceIntent {
    const intent = workspaceIntentSchema.parse(input);
    const candidate = this.candidate(workspaceId, candidateId, candidateVersion);
    if (!candidate || candidate.status !== 'active') throw new Error('候选版本不存在或已失效');
    const directory = resolve(this.storage.workspacePath(workspaceId), 'candidates', candidateId, 'intents');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `${intent.intentId}.json`);
    const existing = this.storage.readOptionalFile(path);
    if (existing) {
      // Intent identifiers are immutable audit references.  Retrying the same
      // request is safe; replacing its contents after evidence was collected
      // is not.
      try {
        const parsed = workspaceIntentSchema.parse(JSON.parse(existing));
        if (JSON.stringify(parsed) === JSON.stringify(intent)) return parsed;
      } catch {
        // A malformed existing record must not be overwritten either.
      }
      throw new Error('同一 intentId 已记录为不同内容，拒绝覆盖审计意图');
    }
    this.storage.atomicWrite(path, JSON.stringify(intent));
    return intent;
  }

  geometryVerificationContext(input: unknown): { candidate: WorkspaceCandidate; intent: WorkspaceIntent; observation: CandidateObservation } {
    const request = candidateGeometryValidationRequestSchema.parse(input);
    const candidate = this.candidate(request.workspaceId, request.candidateId, request.candidateVersion);
    if (!candidate || candidate.status !== 'active' || candidate.baseRevision !== request.baseRevision
      || candidate.contentHash !== request.contentHash || candidate.renderMode !== request.renderMode) {
      throw new Error('候选版本已变化，拒绝启动几何验证');
    }
    const intent = this.readCandidateIntent(request.workspaceId, request.candidateId, request.intentId);
    if (!intent || intent.version !== request.intentVersion) throw new Error('几何验证引用的需求意图不存在、来自旧协议或版本不匹配；请重新规划候选');
    const observation = this.readCandidateJson<CandidateObservation>(request.workspaceId, request.candidateId, 'observations', request.candidateObservationId);
    if (!observation || observation.baseRevision !== request.baseRevision || observation.candidateVersion !== request.candidateVersion
      || observation.contentHash !== request.contentHash || observation.renderMode !== request.renderMode) {
      throw new Error('几何验证引用的候选观察不存在或版本不匹配');
    }
    return { candidate, intent, observation };
  }

  recordValidation(input: unknown): ValidationRecord {
    const request = validationRecordRequestSchema.parse(input);
    const candidate = this.candidate(request.workspaceId, request.candidateId, request.candidateVersion);
    if (!candidate || candidate.status !== 'active' || candidate.baseRevision !== request.baseRevision
      || candidate.contentHash !== request.contentHash || candidate.renderMode !== request.renderMode) {
      throw new Error('候选版本已变化，拒绝写入过期验证');
    }
    const intent = this.readCandidateIntent(request.workspaceId, request.candidateId, request.intentId);
    if (!intent || intent.version !== request.intentVersion) throw new Error('验证引用的需求意图不存在、来自旧协议或版本不匹配；请重新规划候选');
    const observation = this.readCandidateJson<CandidateObservation>(request.workspaceId, request.candidateId, 'observations', request.candidateObservationId);
    if (!observation || observation.baseRevision !== request.baseRevision || observation.candidateVersion !== request.candidateVersion
      || observation.contentHash !== request.contentHash || observation.renderMode !== request.renderMode) {
      throw new Error('验证引用的候选观察不存在或版本不匹配');
    }
    const files = this.storage.readWorkspaceFiles(resolve(this.storage.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'versions', String(request.candidateVersion).padStart(3, '0')));
    let staticOk = false;
    let staticMessage = '';
    try {
      validateWorkspaceFiles(files);
      staticOk = true;
      staticMessage = 'HTML、CSS、结构与资源引用校验通过';
    } catch (error) {
      staticMessage = error instanceof Error ? error.message : '静态校验失败';
    }
    const visualArtifacts = request.visualReview?.artifactIds ?? [];
    const visualOk = !request.policy.visualRequired || (request.visualReview?.status === 'passed'
      && Boolean(observation.screenshotArtifactId)
      && visualArtifacts.includes(observation.screenshotArtifactId!)
      && visualArtifacts.every(artifactId => this.candidateArtifactMatches(request, artifactId)));
    const results = new Map(request.constraintResults.map(item => [item.id, item]));
    const requiredResultPassed = (id: string) => {
      const result = results.get(id);
      return Boolean(result?.required && result.status === 'passed' && result.observationId === observation.observationId);
    };
    // The names are deliberately derived from durable intent data, rather than
    // from page classes or natural-language keywords.  A verifier must provide
    // one observation-backed result for each declared target and constraint.
    const expectedSourceChecks = intent.sourceIds.map(sourceId => `source:${sourceId}`);
    const expectedConstraintChecks = intent.renderConstraintIndexes.map(index => `constraint:${index}`);
    const intentCoverageOk = expectedSourceChecks.concat(expectedConstraintChecks).every(requiredResultPassed);
    // A target may intentionally disappear (for example, "remove this
    // banner").  Its source result is still required and must cite this
    // observation, but presence itself is decided by the declared constraint
    // rather than imposed as a universal invariant here.
    const readiness = observation.observation.readiness;
    const renderReady = readiness.layoutStable && readiness.fonts === 'ready'
      && readiness.images.failed === 0 && readiness.images.ready >= readiness.images.total;
    const requiredOk = request.constraintResults.filter(item => item.required).every(item => item.status === 'passed');
    const hasUnknown = request.constraintResults.some(item => item.required && item.status === 'unknown')
      || (request.policy.visualRequired && (request.visualReview?.status === 'unknown' || !request.visualReview));
    const overall = staticOk && request.staticChecks.status === 'passed' && requiredOk && intentCoverageOk
      && renderReady && visualOk
      ? 'passed' as const
      : hasUnknown ? 'unverifiable' as const : 'failed' as const;
    const record: ValidationRecord = {
      ...request,
      staticChecks: {
        status: staticOk ? request.staticChecks.status : 'failed',
        message: `${request.staticChecks.message}\n${staticMessage}\n意图覆盖=${intentCoverageOk}；渲染就绪=${renderReady}`.slice(0, 4_000)
      },
      validationId: randomUUID(),
      overall,
      recordedAt: new Date().toISOString()
    };
    const directory = resolve(this.storage.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'validations');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.storage.atomicWrite(resolve(directory, `${record.validationId}.json`), JSON.stringify(record));
    return record;
  }

  publishCandidate(input: unknown): CandidatePublishResult {
    const request = candidatePublishRequestSchema.parse(input);
    const candidate = this.candidate(request.workspaceId, request.candidateId, request.candidateVersion);
    if (!candidate || candidate.status !== 'active' || candidate.baseRevision !== request.baseRevision
      || candidate.contentHash !== request.contentHash || candidate.renderMode !== request.renderMode) throw new Error('候选版本已变化，拒绝发布');
    const commit = this.readCandidateJson<CandidatePublishResult>(request.workspaceId, request.candidateId, 'commits', request.commitId);
    if (commit) return commit;
    const validation = this.readCandidateJson<ValidationRecord>(request.workspaceId, request.candidateId, 'validations', request.validationId);
    if (!validation || validation.overall !== 'passed' || validation.baseRevision !== request.baseRevision
      || validation.candidateVersion !== request.candidateVersion || validation.contentHash !== request.contentHash
      || validation.renderMode !== request.renderMode) throw new Error('没有可用于发布的通过验证记录');
    const intent = this.readCandidateIntent(request.workspaceId, request.candidateId, validation.intentId);
    if (!intent || intent.version !== validation.intentVersion || intent.sourceIds.length === 0 || intent.constraints.length === 0) {
      throw new Error('通过验证记录引用的需求意图不存在、不完整或版本不匹配');
    }
    const files = this.storage.readWorkspaceFiles(resolve(this.storage.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'versions', String(request.candidateVersion).padStart(3, '0')));
    const commitsDirectory = resolve(this.storage.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'commits');
    mkdirSync(commitsDirectory, { recursive: true, mode: 0o700 });
    const pendingPath = resolve(commitsDirectory, `${request.commitId}.pending.json`);
    const pending = this.storage.readOptionalFile(pendingPath);
    if (!pending) {
      // Persist the idempotency identity before changing the formal document.
      // If the process stops after commitWorkingCopy, a retry can recover the
      // receipt from the already-written revision instead of committing again.
      this.storage.atomicWrite(pendingPath, JSON.stringify({ request, preparedAt: new Date().toISOString() }));
    }
    const manifest = this.storage.readManifest(this.storage.workspacePath(request.workspaceId));
    const recoveredRevision = request.baseRevision + 1;
    const recoveredFilesPath = resolve(this.storage.workspacePath(request.workspaceId), 'revisions', String(recoveredRevision).padStart(3, '0'));
    if (manifest.revision === recoveredRevision && existsSync(resolve(recoveredFilesPath, 'index.html'))) {
      const recoveredFiles = this.storage.readWorkspaceFiles(recoveredFilesPath);
      if (this.contentHash(request.workspaceId, recoveredFiles) === request.contentHash) {
        const recovered: CandidatePublishResult = {
          workspaceId: request.workspaceId, candidateId: request.candidateId, candidateVersion: request.candidateVersion,
          revision: recoveredRevision, committedAt: new Date().toISOString(), unchanged: false
        };
        this.storage.atomicWrite(resolve(commitsDirectory, `${request.commitId}.json`), JSON.stringify(recovered));
        return recovered;
      }
    }
    if (manifest.revision !== request.baseRevision) throw new Error('正式版本已变化，候选基线过期');
    const revision = this.commitWorkingCopy(request.workspaceId, files, request.summary);
    const result: CandidatePublishResult = {
      workspaceId: request.workspaceId, candidateId: request.candidateId, candidateVersion: request.candidateVersion,
      revision, committedAt: new Date().toISOString(), unchanged: false
    };
    this.storage.atomicWrite(resolve(commitsDirectory, `${request.commitId}.json`), JSON.stringify(result));
    return result;
  }

  createRenderArtifact(input: unknown): RenderArtifact {
    const request = renderArtifactRequestSchema.parse(input);
    const candidate = this.candidate(request.workspaceId, request.candidateId, request.candidateVersion);
    if (!candidate || candidate.status !== 'active'
      || candidate.baseRevision !== request.baseRevision || candidate.contentHash !== request.contentHash
      || candidate.renderMode !== request.renderMode) throw new Error('候选版本已变化，拒绝写入截图证据');
    const encoded = request.dataUrl.slice('data:image/png;base64,'.length);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('截图大小不在允许范围内');
    // PNG signature prevents a data URL MIME declaration from disguising a different file.
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('截图不是有效 PNG');
    const artifact: RenderArtifact = {
      workspaceId: request.workspaceId,
      baseRevision: request.baseRevision,
      candidateId: request.candidateId,
      candidateVersion: request.candidateVersion,
      contentHash: request.contentHash,
      renderMode: request.renderMode,
      jobId: request.jobId,
      sampleId: request.sampleId,
      capture: request.capture,
      artifactId: randomUUID(),
      mimeType: 'image/png',
      byteLength: bytes.length,
      createdAt: new Date().toISOString()
    };
    const directory = resolve(this.storage.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'artifacts');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.storage.atomicWrite(resolve(directory, `${artifact.artifactId}.png`), bytes);
    this.storage.atomicWrite(resolve(directory, `${artifact.artifactId}.json`), JSON.stringify(artifact));
    return artifact;
  }

  renderArtifactMatches(document: Pick<RenderArtifact, 'workspaceId' | 'baseRevision' | 'candidateId' | 'candidateVersion' | 'contentHash' | 'renderMode' | 'jobId' | 'sampleId'>, observation: Pick<LiveWorkspaceObservation, 'viewport' | 'scroll'>, artifactId: string): boolean {
    if (!/^[0-9a-f-]{36}$/i.test(artifactId)) return false;
    const raw = this.storage.readOptionalFile(resolve(this.storage.workspacePath(document.workspaceId), 'candidates', document.candidateId, 'artifacts', `${artifactId}.json`));
    if (!raw) return false;
    try {
      const artifact = JSON.parse(raw) as RenderArtifact;
      return artifact.artifactId === artifactId && artifact.workspaceId === document.workspaceId
        && artifact.baseRevision === document.baseRevision && artifact.candidateId === document.candidateId
        && artifact.candidateVersion === document.candidateVersion && artifact.contentHash === document.contentHash
        && artifact.renderMode === document.renderMode && artifact.jobId === document.jobId && artifact.sampleId === document.sampleId
        && artifact.capture.viewport.width === observation.viewport.width && artifact.capture.viewport.height === observation.viewport.height
        && artifact.capture.viewport.devicePixelRatio === observation.viewport.devicePixelRatio
        && artifact.capture.scroll.x === observation.scroll.x && artifact.capture.scroll.y === observation.scroll.y;
    } catch {
      return false;
    }
  }

  private candidateArtifactMatches(document: Pick<ValidationRecord, 'workspaceId' | 'baseRevision' | 'candidateId' | 'candidateVersion' | 'contentHash' | 'renderMode'>, artifactId: string): boolean {
    if (!/^[0-9a-f-]{36}$/i.test(artifactId)) return false;
    const raw = this.storage.readOptionalFile(resolve(this.storage.workspacePath(document.workspaceId), 'candidates', document.candidateId, 'artifacts', `${artifactId}.json`));
    if (!raw) return false;
    try {
      const artifact = JSON.parse(raw) as RenderArtifact;
      return artifact.artifactId === artifactId && artifact.workspaceId === document.workspaceId
        && artifact.baseRevision === document.baseRevision && artifact.candidateId === document.candidateId
        && artifact.candidateVersion === document.candidateVersion && artifact.contentHash === document.contentHash
        && artifact.renderMode === document.renderMode;
    } catch { return false; }
  }

  previewHtml(workspaceId: string, candidate: 'A' | 'B' = 'A', assetQuery = ''): string | undefined {
    if (!this.get(workspaceId)) return undefined;
    if (candidate === 'A' && !this.frozenStyleVariantEnabled) return undefined;
    const directory = this.storage.workspacePath(workspaceId);
    return this.previewHtmlFromFiles(workspaceId, this.storage.readWorkspaceFiles(directory), candidate, assetQuery);
  }

  private previewHtmlFromFiles(
    workspaceId: string, files: WorkspaceFiles, candidate: 'A' | 'B', assetQuery: string,
    workspaceAssetPath = '', candidateAssetPath = workspaceAssetPath
  ): string | undefined {
    return renderWorkspacePreview({
      files, candidate, assetQuery, workspaceAssetPath, candidateAssetPath,
      authorResources: this.authorStyleResources(workspaceId),
      unreadableStyleSources: this.unreadableAuthorStyleSources(workspaceId),
      authorSheets: this.authorStyleSheets(workspaceId),
      authorCss: this.authorCss(workspaceId),
      authorRulesAvailable: this.hasAuthorRuleCandidate(workspaceId)
    });
  }

  conversation(workspaceId: string): CodingAgentConversationTurn[] {
    const directory = this.storage.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const manifest = this.storage.readManifest(directory);
    return (manifest.conversation ?? [])
      .filter(turn => (turn.revision ?? 0) <= manifest.revision)
      .slice(-8)
      .map(({ instruction, result }) => ({ instruction, result }));
  }

  chat(workspaceId: string): WorkspaceChatEntry[] {
    const directory = this.storage.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const manifest = this.storage.readManifest(directory);
    return (manifest.chat ?? [])
      .filter(entry => entry.revision <= manifest.revision)
      .slice(-200);
  }

  appendChat(workspaceId: string, entry: WorkspaceChatEntry): void {
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
      chat: [...(manifest.chat ?? []), entry].slice(-200)
    });
  }

  recordTurn(workspaceId: string, request: SourceTurnRequest, response: SourceTurnResponse): void {
    // Candidate drafts are intentionally not mixed into the formal-revision
    // conversation history. M3 will add draft-session recovery separately.
    if (response.kind === 'draft') return;
    const directory = this.storage.workspacePath(workspaceId);
    const manifest = this.storage.readManifest(directory);
    if (response.kind === 'failed' || response.kind === 'cancelled') return;
    const result = response.kind === 'completed' ? response.summary : response.question;
    const revision = response.kind === 'completed' ? response.revision : manifest.revision;
    const retained = response.kind === 'completed'
      ? (manifest.conversation ?? []).filter(turn => (turn.revision ?? 0) < response.revision)
      : (manifest.conversation ?? []);
    const linked = response.kind === 'completed'
      ? retained.map(turn => turn.pending && (
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
        ? (manifest.chat ?? []).filter(entry => entry.revision < response.revision).map(entry => {
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
      conversation: [
        ...linked,
        {
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
      ].slice(-40)
    });
  }

  tools(workspaceId: string, candidateInput?: WorkspaceCandidate): CodingWorkspaceTools {
    const workspaceDirectory = this.storage.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    if (this.active.has(workspaceId)) throw new Error('当前工作区已有正在执行的修改');
    const candidate = candidateInput && this.candidate(workspaceId, candidateInput.candidateId, candidateInput.candidateVersion);
    if (candidateInput && (!candidate || candidate.status !== 'active')) throw new Error('候选版本不存在或已失效');
    const directory = candidate
      ? resolve(workspaceDirectory, 'candidates', candidate.candidateId, 'versions', String(candidate.candidateVersion).padStart(3, '0'))
      : workspaceDirectory;
    this.active.add(workspaceId);
    try {
      const original = this.storage.readWorkspaceFiles(directory);
      const authorRuleMode = this.hasAuthorRuleCandidate(workspaceId);
      return createEditingSession({
        original,
        initial: candidate ? original : this.storage.readWorkspaceFiles(resolve(workspaceDirectory, 'revisions', '000')),
        candidate,
        authorRuleMode,
        authorCssContent: authorRuleMode ? this.authorCss(workspaceId) ?? '' : '',
        unreadableStyleSources: this.unreadableAuthorStyleSources(workspaceId),
        layoutIndex: () => this.capturedLayoutIndex(workspaceId),
        currentRevision: () => this.storage.readManifest(workspaceDirectory).revision,
        commit: (files, summary) => this.commitWorkingCopy(workspaceId, files, summary),
        commitCandidate: files => {
          if (!candidate) throw new Error('当前编辑会话没有候选版本');
          return this.updateCandidateFiles(workspaceId, candidate.candidateId, candidate.candidateVersion, files);
        },
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

  private contentHash(workspaceId: string, files: WorkspaceFiles): string {
    const hash = createHash('sha256');
    for (const path of WORKSPACE_FILES) {
      hash.update(path, 'utf8');
      hash.update('\0', 'utf8');
      hash.update(files[path], 'utf8');
      hash.update('\0', 'utf8');
    }
    // These files are read by B preview from the workspace rather than the
    // candidate directory. They therefore belong to the rendered-document
    // identity even though the candidate never edits them.
    for (const path of ['author.css', 'author-resources.json', 'author-sheets.json', 'author-style-links.json']) {
      hash.update(path, 'utf8');
      hash.update('\0', 'utf8');
      hash.update(this.storage.readOptionalFile(resolve(this.storage.workspacePath(workspaceId), path)) ?? '', 'utf8');
      hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
  }

  private isSafeCandidateId(candidateId: string): boolean {
    return /^[0-9a-f-]{36}$/i.test(candidateId);
  }

  private readCandidateJson<T>(workspaceId: string, candidateId: string, category: 'intents' | 'observations' | 'validations' | 'commits', id: string): T | undefined {
    if (!this.isSafeCandidateId(candidateId) || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const raw = this.storage.readOptionalFile(resolve(this.storage.workspacePath(workspaceId), 'candidates', candidateId, category, `${id}.json`));
    if (!raw) return undefined;
    try { return JSON.parse(raw) as T; } catch { return undefined; }
  }

  /**
   * Intent records are protocol data, not an unchecked JSON blob.  In
   * particular, this prevents candidates created before a required
   * verification field was introduced from failing later with a TypeError.
   */
  private readCandidateIntent(workspaceId: string, candidateId: string, intentId: string): WorkspaceIntent | undefined {
    const raw = this.readCandidateJson<unknown>(workspaceId, candidateId, 'intents', intentId);
    const parsed = workspaceIntentSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
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
