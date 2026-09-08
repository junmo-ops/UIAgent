import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { type CodingAgentConversationTurn, type CodingWorkspaceTools } from '@ui-agent/agent-runtime';
import {
  PROTOCOL_VERSION,
  CAPTURED_LAYOUT_PROPERTIES,
  staticSnapshotSchema,
  MAX_STATIC_SNAPSHOT_HTML_CHARS,
  authorStyleCaptureSchema,
  authorStyleSheetSchema,
  candidateObservationRequestSchema,
  candidateGeometryValidationRequestSchema,
  renderArtifactRequestSchema,
  workspaceIntentSchema,
  validationRecordRequestSchema,
  candidatePublishRequestSchema,
  type SnapshotMetrics,
  type AuthorStyleCapture,
  type AuthorStyleResource,
  type AuthorStyleSheet,
  type StaticSnapshot,
  type WorkspaceCandidate,
  type CandidateObservation,
  type RenderArtifact,
  type LiveWorkspaceObservation,
  type WorkspaceIntent,
  type ValidationRecord,
  type CandidatePublishResult,
  type SourceTurnRequest,
  type SourceTurnResponse,
  type WorkspaceChatEntry
} from '@ui-agent/contracts';
import { compileSourceWorkspace, refreshWorkspaceIndexes } from './compiler';
import { validateControlledInteractions } from './interactions';
import { analyzeStaticVisibility, staticVisibilityIssueKey } from './visibility';
import { diagnoseSnapshotPackage, type SnapshotDiagnostics } from './snapshot-diagnostics';

const WORKSPACE_FILES = ['index.html', 'snapshot.css', 'author-overrides.css', 'outline.json', 'source-map.json'] as const;
type WorkspaceFile = typeof WORKSPACE_FILES[number];
type WorkspaceFiles = Record<WorkspaceFile, string>;
type CapturedLayoutIndex = NonNullable<StaticSnapshot['layoutIndex']>;
const LAYOUT_INDEX_FILE = 'layout-index.json';

interface CandidateManifest extends WorkspaceCandidate {
  workspaceId: string;
  /** Bounded, observation-triggered repair attempts for this candidate lineage. */
  repairAttempts: number;
}

interface StructureNode {
  sourceId: string;
  tag: string;
  role?: string;
  text: string;
  depth: number;
  parentSourceId?: string;
  childrenSourceIds: string[];
  classes: string[];
}

function structureQueryTerms(query: string): string[] {
  return [...new Set(
    query
      .toLocaleLowerCase()
      .split(/[\s,，。；;、|/\\()[\]{}"'“”‘’]+/)
      .map(part => part.trim())
      .filter(part => part.length >= 2)
  )].slice(0, 12);
}

function normalizeStructureSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\u00a0]+/g, '');
}

function structureNeighborhood(nodes: StructureNode[], sourceId: string): Record<string, unknown> {
  const node = nodes.find(item => item.sourceId === sourceId);
  if (!node) return { sourceId };
  const parent = node.parentSourceId ? nodes.find(item => item.sourceId === node.parentSourceId) : undefined;
  const siblings = parent?.childrenSourceIds
    .filter(candidate => candidate !== sourceId)
    .map(candidate => nodes.find(item => item.sourceId === candidate))
    .filter((item): item is StructureNode => Boolean(item))
    .slice(0, 8)
    .map(item => ({ sourceId: item.sourceId, tag: item.tag, text: item.text, role: item.role })) ?? [];
  return {
    sourceId: node.sourceId,
    tag: node.tag,
    role: node.role,
    text: node.text,
    classes: node.classes.slice(0, 12),
    parent: parent ? { sourceId: parent.sourceId, tag: parent.tag, text: parent.text, role: parent.role } : undefined,
    children: node.childrenSourceIds.slice(0, 12),
    siblings
  };
}

const UNSAFE_HTML_RULES = [
  { label: '活动或嵌入式标签', pattern: /<\s*(script|iframe|frame|object|embed|base)\b/i },
  { label: '外部样式链接', pattern: /<\s*link\b/i },
  { label: 'HTTP Meta 指令', pattern: /<\s*meta\b[^>]*\bhttp-equiv\s*=/i },
  { label: 'DOM 事件属性', pattern: /\son[a-z]+\s*=/i },
  { label: 'srcdoc 嵌入内容', pattern: /\ssrcdoc\s*=/i },
  {
    label: 'HTTP/HTTPS 外部资源属性',
    pattern: /\s(?:src|srcset|href|action|formaction|poster)\s*=\s*["']?\s*(?:https?:|\/\/)/i
  }
];

const URL_BEARING_ATTRIBUTES = new Set([
  'href', 'src', 'srcset', 'action', 'formaction', 'poster', 'xlink:href'
]);

function normalizeUrlProtocol(value: string): string {
  // Browsers ignore ASCII whitespace and control characters while resolving a
  // scheme. Normalize them before checking so `java&#x0A;script:` cannot evade
  // the attribute-level guard.
  return value.trim().replace(/[\u0000-\u0020\u007f]+/g, '').toLocaleLowerCase();
}

function containsUnsafeCssExecutableContent(css: string): boolean {
  const executableCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\b(?:expression\s*\(|-moz-binding\b|behavior\s*:)/i.test(executableCss)) return true;
  for (const match of executableCss.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (normalizeUrlProtocol(target).startsWith('javascript:')) return true;
  }
  return false;
}

function validateCssResourceUrls(css: string, errorMessage: string): void {
  for (const match of css.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim().toLowerCase();
    if (target.startsWith('#') || target.startsWith('data:') || /^https?:\/\//i.test(target)) continue;
    throw new Error(errorMessage);
  }
}

function validateEmbeddedHtmlSafety(html: string): void {
  const { document } = parseHTML(html);
  for (const element of [...document.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase();
      if (URL_BEARING_ATTRIBUTES.has(name) && normalizeUrlProtocol(attribute.value).startsWith('javascript:')) {
        throw new Error('源码包含脚本、事件、远程资源或其他不安全内容（检测到：javascript URL）');
      }
      if (name === 'style') {
        if (containsUnsafeCssExecutableContent(attribute.value)) {
          throw new Error('源码包含脚本、事件、远程资源或其他不安全内容（检测到：CSS 可执行内容）');
        }
        validateCssResourceUrls(attribute.value, '源码包含脚本、事件、远程资源或其他不安全内容（检测到：CSS 外部 url()）');
      }
    }
    if (element.localName === 'style') {
      const css = element.textContent ?? '';
      if (/@import\b/i.test(css)) {
        throw new Error('源码包含脚本、事件、远程资源或其他不安全内容（检测到：CSS @import）');
      }
      if (containsUnsafeCssExecutableContent(css)) {
        throw new Error('源码包含脚本、事件、远程资源或其他不安全内容（检测到：CSS 可执行内容）');
      }
      validateCssResourceUrls(css, '源码包含脚本、事件、远程资源或其他不安全内容（检测到：CSS 外部 url()）');
    }
  }
}

interface WorkspaceManifest {
  workspaceVersion?: 1 | 2;
  workspaceId: string;
  ownerId?: string;
  tenantId?: string;
  title: string;
  sourceUrl: string;
  selectedSourceId: string;
  snapshotMetrics?: SnapshotMetrics;
  viewport?: { width: number; height: number };
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  revision: number;
  maxRevision: number;
  summaries: Array<{ revision: number; summary: string; timestamp: string }>;
  conversation?: WorkspaceConversationTurn[];
  /** User-visible discussion history. It is separate from the compact Agent context above. */
  chat?: WorkspaceChatEntry[];
}

function validateAuthorCss(css: string, _resources: AuthorStyleResource[]): string {
  if (css.length > 30_000_000) throw new Error('author.css 超过 30 MB 限制');
  if (/<\/style/i.test(css)) throw new Error('author.css 包含非法的 style 闭合标签');
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (containsUnsafeCssExecutableContent(css)) {
    throw new Error('author.css 包含不安全的可执行内容');
  }
  const executableCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const imports = new Set(cssImportSources(executableCss));
  for (const source of imports) {
    if (!/^https?:\/\//i.test(source)) throw new Error('author.css 包含不安全的 @import');
  }
  for (const match of css.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!target || target.startsWith('#') || target.startsWith('data:')) continue;
    if (imports.has(target)) continue;
    if (!/^https?:\/\//i.test(target)) throw new Error('author.css 包含不支持的资源协议');
  }
  return 'author.css 与资源清单校验通过';
}

function cssImportSources(css: string): string[] {
  const sources: string[] = [];
  const pattern = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')/gi;
  for (const match of css.matchAll(pattern)) {
    const source = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (source) sources.push(source);
  }
  return sources;
}

interface WorkspaceConversationTurn extends CodingAgentConversationTurn {
  /** Workspace revision visible immediately after this turn. */
  revision?: number;
  /** Clarification awaiting a successful source-changing follow-up. */
  pending?: boolean;
  /** Stable identifier used to associate a user's follow-up with this question. */
  clarificationId?: string;
  /** Clarification answered by this turn. */
  replyToClarificationId?: string;
  /** Structured option selected for the clarification, when applicable. */
  clarificationOptionId?: string;
}

export interface SourceWorkspace {
  workspaceId: string;
  title: string;
  sourceUrl: string;
  selectedSourceId: string;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  snapshotMetrics?: SnapshotMetrics;
}

function validateHtml(html: string): string {
  if (!/<!doctype html>/i.test(html) || !/<html\b/i.test(html) || !/<body\b/i.test(html)) {
    throw new Error('index.html 缺少完整的 doctype、html 或 body 结构');
  }
  const unsafe = UNSAFE_HTML_RULES.find(rule => rule.pattern.test(html));
  if (unsafe) throw new Error(`源码包含脚本、事件、远程资源或其他不安全内容（检测到：${unsafe.label}）`);
  validateEmbeddedHtmlSafety(html);
  validateTableStructure(html);
  validateControlledInteractions(html);
  if (html.length > MAX_STATIC_SNAPSHOT_HTML_CHARS) {
    throw new Error(`index.html 超过 ${Math.round(MAX_STATIC_SNAPSHOT_HTML_CHARS / 1_000_000)} MB 限制`);
  }
  return 'HTML 与安全规则校验通过';
}

function validateCss(css: string): string {
  if (css.length > 10_000_000) throw new Error('snapshot.css 超过 10 MB 限制');
  if (/<\/style/i.test(css)) throw new Error('snapshot.css 包含非法的 style 闭合标签');
  // Comments are not executable CSS and must not trigger resource/legacy-code checks.
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const source of cssImportSources(css.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    if (!/^https?:\/\//i.test(source)) throw new Error('CSS @import 必须使用 HTTP/HTTPS 地址');
  }
  if (/<\/style/i.test(css)) throw new Error('snapshot.css 包含非法的 style 闭合标签');
  if (containsUnsafeCssExecutableContent(css)) {
    throw new Error('snapshot.css 包含不安全的可执行内容');
  }
  for (const match of css.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim().toLowerCase();
    if (target.startsWith('#') || target.startsWith('data:') || /^https?:\/\//i.test(target)) continue;
    throw new Error('snapshot.css 包含外部 url()');
  }
  return 'CSS 与安全规则校验通过';
}

function validateTableStructure(html: string): void {
  const structuralTags = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
  const stack: string[] = [];
  const token = /<\s*(\/?)\s*(table|thead|tbody|tfoot|tr|td|th)\b[^>]*>/ig;
  for (const match of html.matchAll(token)) {
    const closing = Boolean(match[1]);
    const tag = match[2]!.toLowerCase();
    if (!structuralTags.has(tag)) continue;
    if (!closing) {
      const parent = stack.at(-1);
      if ((tag === 'td' || tag === 'th') && parent !== 'tr') {
        throw new Error(`<${tag}> 必须位于 <tr> 内`);
      }
      if (tag === 'tr' && parent && !['table', 'thead', 'tbody', 'tfoot'].includes(parent)) {
        throw new Error('<tr> 的表格层级无效');
      }
      stack.push(tag);
      continue;
    }
    const current = stack.pop();
    if (current !== tag) {
      throw new Error(`表格标签结构无效：期望闭合 </${current ?? '无'}>，实际为 </${tag}>`);
    }
  }
  if (stack.length) throw new Error(`表格标签结构无效：<${stack.at(-1)}> 未闭合`);
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(search, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(1, search.length);
  }
}

const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findTagEnd(content: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  throw new Error('目标元素的开始标签不完整');
}

function sourceElementRange(content: string, sourceId: string): { start: number; end: number; tag: string } {
  const marker = new RegExp(`data-ui-source-id\\s*=\\s*["']${escapeRegExp(sourceId)}["']`, 'i').exec(content);
  if (!marker || marker.index === undefined) throw new Error(`源码中不存在元素 ${sourceId}`);
  const start = content.lastIndexOf('<', marker.index);
  if (start < 0) throw new Error(`元素 ${sourceId} 的开始标签无效`);
  const openingEnd = findTagEnd(content, start);
  const tag = /^<\s*([a-z][\w:-]*)/i.exec(content.slice(start, openingEnd + 1))?.[1]?.toLowerCase();
  if (!tag) throw new Error(`元素 ${sourceId} 的标签名无效`);
  if (VOID_HTML_TAGS.has(tag) || /\/\s*>$/.test(content.slice(start, openingEnd + 1))) {
    return { start, end: openingEnd + 1, tag };
  }

  const token = new RegExp(`<\\s*(\\/?)\\s*${escapeRegExp(tag)}\\b`, 'ig');
  token.lastIndex = start;
  let depth = 0;
  while (true) {
    const match = token.exec(content);
    if (!match || match.index === undefined) throw new Error(`元素 ${sourceId} 缺少闭合标签`);
    const tagEnd = findTagEnd(content, match.index);
    if (match[1]) {
      depth -= 1;
      if (depth === 0) return { start, end: tagEnd + 1, tag };
    } else if (!/\/\s*>$/.test(content.slice(match.index, tagEnd + 1))) {
      depth += 1;
    }
    token.lastIndex = tagEnd + 1;
  }
}

interface SourceElementAncestor {
  sourceId: string;
  tag: string;
}

function sourceElementAncestry(content: string, sourceId: string): SourceElementAncestor[] {
  const token = /<\s*(\/?)\s*([a-z][\w:-]*)\b/ig;
  const stack: Array<{ sourceId?: string; tag: string }> = [];

  while (true) {
    const match = token.exec(content);
    if (!match || match.index === undefined) break;
    const closing = Boolean(match[1]);
    const tag = match[2]!.toLowerCase();
    const tagEnd = findTagEnd(content, match.index);
    const rawTag = content.slice(match.index, tagEnd + 1);

    if (closing) {
      const matchingIndex = stack.map(item => item.tag).lastIndexOf(tag);
      if (matchingIndex >= 0) stack.splice(matchingIndex);
    } else {
      const marker = /\bdata-ui-source-id\s*=\s*["']([^"']+)["']/i.exec(rawTag)?.[1];
      const entry = { sourceId: marker, tag };
      if (marker === sourceId) {
        return [...stack, entry]
          .filter((item): item is SourceElementAncestor => Boolean(item.sourceId))
          .map(item => ({ sourceId: item.sourceId, tag: item.tag }));
      }
      if (!VOID_HTML_TAGS.has(tag) && !/\/\s*>$/.test(rawTag)) stack.push(entry);
    }
    token.lastIndex = tagEnd + 1;
  }

  throw new Error(`源码中不存在元素 ${sourceId}`);
}

function elementClosingTagStart(
  content: string,
  range: { start: number; end: number; tag: string }
): number {
  const outerHtml = content.slice(range.start, range.end);
  const closing = new RegExp(`<\\/\\s*${escapeRegExp(range.tag)}\\s*>\\s*$`, 'i').exec(outerHtml);
  if (!closing || closing.index === undefined) throw new Error(`元素缺少 </${range.tag}> 闭合标签`);
  return range.start + closing.index;
}

function cloneWithFreshSourceIds(
  content: string,
  outerHtml: string
): { html: string; rootSourceId: string; sourceIdMap: Map<string, string> } {
  let nextId = Math.max(
    -1,
    ...[...content.matchAll(/\bdata-ui-source-id\s*=\s*["']source-(\d+)["']/gi)]
      .map(match => Number(match[1]))
      .filter(Number.isFinite)
  ) + 1;
  let rootSourceId: string | undefined;
  const sourceIdMap = new Map<string, string>();
  const html = outerHtml.replace(
    /(\bdata-ui-source-id\s*=\s*["'])([^"']+)(["'])/gi,
    (_match, prefix: string, previousSourceId: string, suffix: string) => {
      const sourceId = `source-${nextId++}`;
      rootSourceId ??= sourceId;
      sourceIdMap.set(previousSourceId, sourceId);
      return `${prefix}${sourceId}${suffix}`;
    }
  ).replace(/\sdata-ui-agent-(?:source-rect|captured-layout)\s*=\s*(["'])[^"']*\1/gi, '');
  if (!rootSourceId) throw new Error('模板元素缺少 data-ui-source-id，无法安全克隆');
  return { html, rootSourceId, sourceIdMap };
}

function clonedSourceScopedCss(css: string, sourceIdMap: ReadonlyMap<string, string>): string {
  const clonedRules: string[] = [];
  for (const [previousSourceId, nextSourceId] of sourceIdMap) {
    const selector = `\\[data-ui-source-id\\s*=\\s*(["'])${escapeRegExp(previousSourceId)}\\1\\]`;
    const rule = new RegExp(`${selector}(?:::(?:before|after))?\\s*\\{[^}]*\\}`, 'gi');
    for (const match of css.matchAll(rule)) {
      clonedRules.push(match[0].replace(previousSourceId, nextSourceId));
    }
  }
  return clonedRules.join('\n');
}

export interface WorkspaceOwner {
  userId: string;
  tenantId: string;
}

const LOCAL_WORKSPACE_OWNER: WorkspaceOwner = {
  userId: 'local-developer',
  tenantId: 'local'
};

export interface ManagedSourceWorkspace extends SourceWorkspace {
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface WorkspaceListOptions {
  query?: string;
  status?: 'active' | 'trashed' | 'all';
  offset?: number;
  limit?: number;
}

export interface SourceWorkspaceStoreOptions {
  /** Keep workspace ownership checks enabled unless a pilot explicitly opts out. */
  identityIsolation?: boolean;
  /**
   * Keep the frozen computed-style (A) variant available for diagnostics.
   * Production creation is currently wired with this disabled so replicas
   * use the author-rules (B) variant directly.
   */
  frozenStyleVariantEnabled?: boolean;
}

function sourceElementInnerRange(
  content: string,
  range: { start: number; end: number; tag: string }
): { start: number; end: number } {
  if (VOID_HTML_TAGS.has(range.tag)) throw new Error(`<${range.tag}> 是空元素，没有可编辑的内部内容`);
  return {
    start: findTagEnd(content, range.start) + 1,
    end: elementClosingTagStart(content, range)
  };
}

function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', '&quot;');
}

const PROTECTED_DOM_ATTRIBUTES = new Set(['data-ui-source-id', 'data-ui-agent-source-rect', 'data-ui-agent-captured-layout', 'style']);

function assertMutableAttributeName(name: string): void {
  const normalized = name.toLowerCase();
  if (!/^[a-z_:][a-z0-9_.:-]*$/i.test(name)) throw new Error(`属性名 ${name} 无效`);
  if (PROTECTED_DOM_ATTRIBUTES.has(normalized)) {
    throw new Error(`属性 ${name} 由工作区维护，不能通过结构化属性工具修改`);
  }
}

function updateOpeningTagAttributes(
  openingTag: string,
  set: Readonly<Record<string, string>>,
  remove: readonly string[]
): string {
  let next = openingTag;
  const requested = new Map<string, string>();
  for (const [name, value] of Object.entries(set)) {
    assertMutableAttributeName(name);
    requested.set(name.toLowerCase(), value);
  }
  for (const name of remove) {
    assertMutableAttributeName(name);
    if (requested.has(name.toLowerCase())) throw new Error(`属性 ${name} 不能同时设置和删除`);
    const pattern = new RegExp(`\\s${escapeRegExp(name)}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, 'i');
    next = next.replace(pattern, '');
  }
  for (const [name, value] of Object.entries(set)) {
    const rendered = `${name}="${escapeHtmlAttribute(value)}"`;
    const pattern = new RegExp(`(\\s)${escapeRegExp(name)}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=\\s|/?>)`, 'i');
    if (pattern.test(next)) next = next.replace(pattern, `$1${rendered}`);
    else next = next.replace(/\s*\/?>$/, match => ` ${rendered}${match}`);
  }
  return next;
}

function nextSourceNumber(content: string): number {
  return Math.max(
    -1,
    ...[...content.matchAll(/\bdata-ui-source-id\s*=\s*["']source-(\d+)["']/gi)]
      .map(match => Number(match[1]))
      .filter(Number.isFinite)
  ) + 1;
}

function fragmentWithFreshSourceIds(
  content: string,
  fragmentHtml: string
): { html: string; rootSourceIds: string[] } {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const container = document.createElement('div');
  container.innerHTML = fragmentHtml;
  const elements = [...container.querySelectorAll('*')];
  if (!elements.length) throw new Error('插入内容必须至少包含一个 HTML 元素');
  let nextId = nextSourceNumber(content);
  for (const element of elements) {
    element.removeAttribute('data-ui-agent-source-rect');
    element.removeAttribute('data-ui-agent-captured-layout');
    element.setAttribute('data-ui-source-id', `source-${nextId++}`);
  }
  const rootSourceIds = [...container.children]
    .map(element => element.getAttribute('data-ui-source-id'))
    .filter((value): value is string => Boolean(value));
  return { html: container.innerHTML, rootSourceIds };
}

function applyFrozenReferenceStyles(
  fragmentHtml: string,
  rootSourceIds: readonly string[],
  sourceHtml: string,
  styleReferenceSourceId: string
): string {
  const referenceRange = sourceElementRange(sourceHtml, styleReferenceSourceId);
  const referenceOpeningTag = sourceHtml.slice(
    referenceRange.start,
    findTagEnd(sourceHtml, referenceRange.start) + 1
  );
  const referenceClasses = /\bclass\s*=\s*["']([^"']+)["']/i.exec(referenceOpeningTag)?.[1]
    ?.split(/\s+/)
    .filter(className => className.startsWith('ui-snapshot-style-')) ?? [];
  if (!referenceClasses.length) {
    throw new Error(`样式参照元素 ${styleReferenceSourceId} 没有冻结计算样式类；请改用已检查的同类元素，或自行提供受作用域控制的 CSS`);
  }
  let next = fragmentHtml;
  for (const sourceId of rootSourceIds) {
    const range = sourceElementRange(next, sourceId);
    const openingEnd = findTagEnd(next, range.start);
    const openingTag = next.slice(range.start, openingEnd + 1);
    const existingClasses = /\bclass\s*=\s*["']([^"']+)["']/i.exec(openingTag)?.[1]
      ?.split(/\s+/)
      .filter(Boolean) ?? [];
    const className = [...new Set([...existingClasses, ...referenceClasses])].join(' ');
    const styledOpeningTag = updateOpeningTagAttributes(openingTag, { class: className }, []);
    next = `${next.slice(0, range.start)}${styledOpeningTag}${next.slice(openingEnd + 1)}`;
  }
  return next;
}

function wrapperOpeningTag(tagName: string, sourceId: string, attributes: Readonly<Record<string, string>>): string {
  if (!/^[a-z][a-z0-9-]*$/i.test(tagName) || VOID_HTML_TAGS.has(tagName.toLowerCase())) {
    throw new Error(`包装标签 ${tagName} 无效或不能包含子节点`);
  }
  const renderedAttributes = Object.entries(attributes).map(([name, value]) => {
    assertMutableAttributeName(name);
    return `${name}="${escapeHtmlAttribute(value)}"`;
  });
  return `<${tagName} data-ui-source-id="${sourceId}"${renderedAttributes.length ? ` ${renderedAttributes.join(' ')}` : ''}>`;
}

function withoutSourceScopedCss(css: string, sourceIds: readonly string[]): string {
  let next = css;
  for (const sourceId of sourceIds) {
    const selector = `\\[data-ui-source-id\\s*=\\s*(["'])${escapeRegExp(sourceId)}\\1\\]`;
    next = next.replace(new RegExp(`${selector}(?:::(?:before|after))?\\s*\\{[^}]*\\}\\s*`, 'gi'), '');
  }
  return next;
}

function decodeBasicEntities(value: string): string {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function compactElementSource(outerHtml: string, maxHtmlChars = 4_000): string {
  const compactHtml = outerHtml
    .replace(/\sstyle="[^"]*"/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxHtmlChars);
  const rawTextSegments = [...outerHtml.matchAll(/>([^<]+)</g)]
    .map(match => match[1]!.trim())
    .filter(Boolean)
    .slice(0, 20);
  const domText = decodeBasicEntities(rawTextSegments.join(' ').replace(/\s+/g, ' ').trim());
  const styleClasses = [...new Set(
    [...outerHtml.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)]
      .flatMap(match => match[1]!.split(/\s+/))
      .filter(className => className.startsWith('ui-snapshot-style-'))
  )].slice(0, 40);
  return [
    `domText: ${JSON.stringify(domText)}`,
    'visibilityNote: domText 仅表示源码中存在文字，不代表元素在渲染后可见；请使用 validate_workspace 检查静态裁剪风险。',
    `rawTextSegments: ${JSON.stringify(rawTextSegments)}`,
    `styleClasses: ${JSON.stringify(styleClasses)}`,
    `compactHtml: ${compactHtml}`
  ].join('\n');
}

const LAYOUT_PROPERTIES = CAPTURED_LAYOUT_PROPERTIES;
const COMPACT_TARGET_LAYOUT_PROPERTIES = new Set([
  'display', 'position', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'overflow', 'overflow-x', 'overflow-y', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink',
  'align-items', 'justify-content', 'gap', 'grid-template-columns', 'grid-auto-flow'
]);
const COMPACT_CONTEXT_LAYOUT_PROPERTIES = new Set([
  'display', 'position', 'width', 'height', 'overflow', 'flex-direction', 'flex-wrap',
  'align-items', 'justify-content', 'gap', 'grid-template-columns'
]);

function extractCapturedLayoutIndex(html: string): { html: string; layoutIndex: CapturedLayoutIndex } {
  const layoutIndex: CapturedLayoutIndex = {};
  const cleaned = html.replace(/<[^>]+>/g, openingTag => {
    if (/^<\//.test(openingTag)) return openingTag;
    const sourceId = /\bdata-ui-source-id\s*=\s*["']([^"']+)["']/i.exec(openingTag)?.[1];
    if (!sourceId) return openingTag;
    const rectValues = /\bdata-ui-agent-source-rect\s*=\s*["']([^"']+)["']/i.exec(openingTag)?.[1]
      ?.split(',').map(Number);
    const captured = /\bdata-ui-agent-captured-layout\s*=\s*["']([^"']+)["']/i.exec(openingTag)?.[1];
    const computedLayout: Record<string, string> = {};
    if (captured) {
      try {
        const facts = JSON.parse(decodeURIComponent(captured));
        for (const property of LAYOUT_PROPERTIES) {
          if (typeof facts?.[property] === 'string') computedLayout[property] = facts[property];
        }
      } catch { /* Ignore malformed capture metadata. */ }
    }
    const capturedRect = rectValues?.length === 4 && rectValues.every(Number.isFinite)
      ? { x: rectValues[0]!, y: rectValues[1]!, width: rectValues[2]!, height: rectValues[3]! }
      : null;
    if (capturedRect || Object.keys(computedLayout).length) layoutIndex[sourceId] = { capturedRect, computedLayout };
    return openingTag.replace(/\sdata-ui-agent-(?:source-rect|captured-layout)\s*=\s*(["'])[^"']*\1/gi, '');
  });
  return { html: cleaned, layoutIndex };
}

function sourceLayoutFacts(
  html: string,
  css: string,
  layoutIndex: CapturedLayoutIndex,
  sourceId: string,
  detail: 'target' | 'context' | 'full' = 'context'
): Record<string, unknown> {
  const range = sourceElementRange(html, sourceId);
  const openingTag = html.slice(range.start, findTagEnd(html, range.start) + 1);
  const classNames = /\bclass\s*=\s*["']([^"']+)["']/i.exec(openingTag)?.[1]?.split(/\s+/) ?? [];
  const capturedFact = layoutIndex[sourceId];
  const declarations = new Map(Object.entries(capturedFact?.computedLayout ?? {}));
  for (const className of classNames.filter(value => value.startsWith('ui-snapshot-style-'))) {
    for (const rule of cssRulesForClass(css, className)) {
      const body = rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'));
      for (const declaration of body.split(';')) {
        const separator = declaration.indexOf(':');
        if (separator < 1) continue;
        const property = declaration.slice(0, separator).trim().toLowerCase();
        if (!LAYOUT_PROPERTIES.includes(property as typeof LAYOUT_PROPERTIES[number])) continue;
        declarations.set(property, declaration.slice(separator + 1).trim());
      }
    }
  }
  const allowedProperties = detail === 'full'
    ? undefined
    : detail === 'target' ? COMPACT_TARGET_LAYOUT_PROPERTIES : COMPACT_CONTEXT_LAYOUT_PROPERTIES;
  const computedLayout = Object.fromEntries([...declarations].filter(([property]) => (
    !allowedProperties || allowedProperties.has(property)
  )));
  return {
    sourceId,
    tag: range.tag,
    capturedRect: capturedFact?.capturedRect ?? null,
    computedLayout,
    inlineStyle: decodeBasicEntities(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(openingTag)?.slice(1).find(value => value !== undefined) ?? ''),
    cascadeNote: 'inlineStyle 是当前源码行内声明（含自定义属性），普通样式表选择器再复杂也不能覆盖同一元素的普通行内声明；computedLayout 是捕获值，不是修改后的生效样式。',
    layoutEvidence: declarations.size ? 'capture-time; not current rendered layout' : 'unavailable; inspect author CSS or recapture with current extension'
  };
}

function cssRulesForClass(content: string, className: string): string[] {
  const token = new RegExp(`(^|[^\\w-])\\.${escapeRegExp(className)}(?![\\w-])`);
  const matches: string[] = [];
  let ruleStart = 0;
  let opening = -1;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') {
      if (depth === 0) opening = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || opening < 0) continue;
    const selector = content.slice(ruleStart, opening).trim();
    if (token.test(selector)) matches.push(`${selector}${content.slice(opening, index + 1)}`);
    ruleStart = index + 1;
    opening = -1;
  }
  return matches;
}

function cssSnippetsForSymbol(content: string, symbol: string, limit = 6): string[] {
  const snippets: string[] = [];
  let offset = 0;
  while (snippets.length < limit) {
    const index = content.indexOf(symbol, offset);
    if (index < 0) break;
    const previousBoundary = Math.max(content.lastIndexOf('}', index - 1), content.lastIndexOf(';', index - 1));
    const nextBoundaryCandidates = [content.indexOf(';', index), content.indexOf('}', index)].filter(value => value >= 0);
    const nextBoundary = nextBoundaryCandidates.length ? Math.min(...nextBoundaryCandidates) + 1 : Math.min(content.length, index + 500);
    const start = Math.max(previousBoundary + 1, index - 300);
    const snippet = content.slice(start, Math.min(nextBoundary, start + 1_000)).trim();
    if (snippet && !snippets.includes(snippet)) snippets.push(snippet);
    offset = index + symbol.length;
  }
  return snippets;
}

export class SourceWorkspaceStore {
  private readonly root: string;
  private readonly identityIsolation: boolean;
  private readonly frozenStyleVariantEnabled: boolean;
  private readonly active = new Set<string>();
  private readonly resourceLoadFailures = new Map<string, Map<number, string>>();

  constructor(root = '.snapshots/source-workspaces', options: SourceWorkspaceStoreOptions = {}) {
    this.root = resolve(root);
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
    const directory = this.workspacePath(workspaceId);
    const initialRevision = resolve(directory, 'revisions', '000');
    mkdirSync(initialRevision, { recursive: true, mode: 0o700 });
    const extractedLayout = extractCapturedLayoutIndex(compiled.html);
    const layoutIndex = { ...extractedLayout.layoutIndex, ...(snapshot.layoutIndex ?? {}) };
    const indexes = refreshWorkspaceIndexes(extractedLayout.html);
    const files: WorkspaceFiles = {
      'index.html': extractedLayout.html,
      'snapshot.css': this.frozenStyleVariantEnabled ? compiled.css : '',
      // B keeps captured author rules immutable. User/agent visual edits live
      // in this versioned layer so they can be undone without mutating capture.
      'author-overrides.css': snapshot.authorOverrides ?? '',
      'outline.json': indexes.outline,
      'source-map.json': indexes.sourceMap
    };
    this.writeWorkspaceFiles(directory, files);
    this.writeWorkspaceFiles(initialRevision, files);
    this.atomicWrite(resolve(directory, LAYOUT_INDEX_FILE), JSON.stringify(layoutIndex));
    if (snapshot.authorStyles) {
      this.atomicWrite(resolve(directory, 'author.css'), snapshot.authorStyles.cssText);
      this.atomicWrite(resolve(directory, 'author-resources.json'), JSON.stringify(snapshot.authorStyles.resources ?? []));
      this.atomicWrite(resolve(directory, 'author-capture.json'), JSON.stringify(snapshot.authorStyles));
      this.atomicWrite(resolve(directory, 'author-style-links.json'), JSON.stringify(snapshot.authorStyles.unreadableSources ?? []));
      this.atomicWrite(resolve(directory, 'author-sheets.json'), JSON.stringify(snapshot.authorStyles.sheets ?? []));
    }
    const now = new Date().toISOString();
    this.writeManifest(directory, {
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
    const directory = this.workspacePath(workspaceId);
    if (!existsSync(resolve(directory, 'workspace.json'))) return undefined;
    const manifest = this.readManifest(directory);
    if (manifest.deletedAt) return undefined;
    return this.workspaceFromManifest(manifest);
  }

  diagnostics(workspaceId: string): SnapshotDiagnostics {
    const directory = this.workspacePath(workspaceId);
    if (!existsSync(resolve(directory, 'workspace.json'))) throw new Error('静态源码工作区不存在');
    const files = this.readWorkspaceFiles(directory);
    return diagnoseSnapshotPackage({
      html: files['index.html'],
      css: files['snapshot.css'],
      outline: files['outline.json'],
      sourceMap: files['source-map.json'],
      authorCss: this.readOptionalFile(resolve(directory, 'author.css')),
      authorResources: this.authorStyleResources(workspaceId),
      authorRenderOnlyStyleCount: this.externalAuthorStyleSources(workspaceId).length,
      authorResourceFailureCount: this.resourceLoadFailures.get(workspaceId)?.size ?? 0
    });
  }

  authorStyles(workspaceId: string): { cssText: string; available: boolean } {
    const directory = this.workspacePath(workspaceId);
    if (!existsSync(resolve(directory, 'workspace.json'))) throw new Error('静态源码工作区不存在');
    const path = resolve(directory, 'author.css');
    return { cssText: this.readOptionalFile(path) ?? '', available: existsSync(path) };
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
    const raw = this.readOptionalFile(resolve(this.workspacePath(workspaceId), 'author-style-links.json'));
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
    const raw = this.readOptionalFile(resolve(this.workspacePath(workspaceId), 'author-sheets.json'));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      const result = authorStyleSheetSchema.array().safeParse(parsed);
      return result.success ? result.data : [];
    } catch {
      return [];
    }
  }

  authorOverrides(workspaceId: string): string {
    const directory = this.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const css = this.readOptionalFile(resolve(directory, 'author-overrides.css')) ?? '';
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
    validateAuthorCss(sheet.cssText, this.authorStyleResources(workspaceId));
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

  private localizeSnapshotResources(html: string, resources: AuthorStyleResource[]): string {
    const urls = new Set(resources.map(resource => resource.url));
    // Escape both HTML attributes and CSS URL delimiters. Never append the
    // workspace preview token to a remote URL.
    const externalUrl = (url: string) => escapeHtmlAttribute(url.replace(/["'<>\s\\()]/g, char => encodeURIComponent(char).replace(/['()]/g, value => `%${value.charCodeAt(0).toString(16)}`)));
    html = html.replace(/#ui-agent-resource-([a-z0-9%_.~-]+)/gi, (marker, encoded) => {
      try {
        const url = decodeURIComponent(encoded);
        return urls.has(url) ? externalUrl(url) : marker;
      } catch { return marker; }
    });
    return html.replace(/\sdata-ui-agent-resource-url="([^"]*)"/gi, (attribute, encodedUrl) => {
      try {
        const url = decodeURIComponent(encodedUrl);
        return urls.has(url) ? ` src="${externalUrl(url)}"` : attribute;
      } catch {
        return attribute;
      }
    });
  }

  authorStyleResources(workspaceId: string): AuthorStyleResource[] {
    const directory = this.workspacePath(workspaceId);
    const raw = this.readOptionalFile(resolve(directory, 'author-resources.json'));
    if (!raw) return [];
    try {
      const resources = JSON.parse(raw) as AuthorStyleResource[];
      return resources.filter(resource => /^https?:\/\//i.test(resource.url) && /^https?:\/\//i.test(resource.sourceUrl));
    } catch {
      return [];
    }
  }

  authorStyleCapture(workspaceId: string): AuthorStyleCapture | undefined {
    const raw = this.readOptionalFile(resolve(this.workspacePath(workspaceId), 'author-capture.json'));
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
        const directory = this.workspacePath(entry.name);
        if (!existsSync(resolve(directory, 'workspace.json'))) return [];
        try {
          const manifest = this.readManifest(directory);
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
    const directory = this.workspacePath(workspaceId);
    if (!existsSync(resolve(directory, 'workspace.json'))) return false;
    try {
      return this.manifestBelongsTo(this.readManifest(directory), owner);
    } catch {
      return false;
    }
  }

  rename(workspaceId: string, title: string): ManagedSourceWorkspace {
    const normalized = title.trim();
    if (!normalized || normalized.length > 200) throw new Error('副本名称长度必须为 1-200 个字符');
    const directory = this.workspacePath(workspaceId);
    const manifest = this.readManifest(directory);
    if (manifest.deletedAt) throw new Error('回收站中的副本不能重命名');
    const updated = { ...manifest, title: normalized, updatedAt: new Date().toISOString() };
    this.writeManifest(directory, updated);
    return this.workspaceFromManifest(updated);
  }

  trash(workspaceId: string): ManagedSourceWorkspace {
    if (this.active.has(workspaceId)) throw new Error('Agent 修改执行期间不能删除副本');
    const directory = this.workspacePath(workspaceId);
    const manifest = this.readManifest(directory);
    const deletedAt = manifest.deletedAt ?? new Date().toISOString();
    const updated = { ...manifest, deletedAt, updatedAt: deletedAt };
    this.writeManifest(directory, updated);
    return this.workspaceFromManifest(updated);
  }

  restoreWorkspace(workspaceId: string): ManagedSourceWorkspace {
    const directory = this.workspacePath(workspaceId);
    const manifest = this.readManifest(directory);
    const { deletedAt: _deletedAt, ...retained } = manifest;
    const updated = { ...retained, updatedAt: new Date().toISOString() };
    this.writeManifest(directory, updated);
    return this.workspaceFromManifest(updated);
  }

  html(workspaceId: string): string | undefined {
    const path = resolve(this.workspacePath(workspaceId), 'index.html');
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }

  exportSnapshot(workspaceId: string): StaticSnapshot | undefined {
    const directory = this.workspacePath(workspaceId);
    const manifestPath = resolve(directory, 'workspace.json');
    if (!existsSync(manifestPath)) return undefined;
    const manifest = this.readManifest(directory);
    if (manifest.deletedAt) return undefined;
    const html = this.readOptionalFile(resolve(directory, 'index.html'));
    if (!html) return undefined;
    const css = this.readOptionalFile(resolve(directory, 'snapshot.css')) ?? '';
    const style = `<style data-ui-agent-workspace-styles>\n${css}\n</style>`;
    const withStyles = /<\/head>/i.test(html)
      ? html.replace(/<\/head>/i, `${style}\n</head>`)
      : /<body\b/i.test(html)
        ? html.replace(/<body\b/i, `${style}\n<body`)
        : html;
    const nodeCount = (withStyles.match(/\bdata-ui-source-id\s*=\s*["']/gi) ?? []).length;
    const authorCss = this.readOptionalFile(resolve(directory, 'author.css'));
    const authorResources = this.authorStyleResources(workspaceId);
    const authorCapture = this.authorStyleCapture(workspaceId);
    const authorSheets = this.authorStyleSheets(workspaceId);
    const authorOverrides = this.readOptionalFile(resolve(directory, 'author-overrides.css')) ?? '';
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
      layoutIndex: this.capturedLayoutIndex(workspaceId, html),
      viewport: manifest.viewport ?? { width: 1440, height: 900 }
    };
  }

  exportActiveSnapshots(owner: WorkspaceOwner = LOCAL_WORKSPACE_OWNER): StaticSnapshot[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
      .flatMap(entry => {
        const directory = this.workspacePath(entry.name);
        if (!existsSync(resolve(directory, 'workspace.json'))) return [];
        try {
          const manifest = this.readManifest(directory);
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
    const sourceDirectory = resolve(this.workspacePath(workspaceId), 'revisions', String(revision).padStart(3, '0'));
    if (revision < 0 || !existsSync(resolve(sourceDirectory, 'index.html'))) throw new Error('候选基线版本不存在');
    const files = this.readWorkspaceFiles(sourceDirectory);
    this.validateWorkspaceFiles(files);
    const candidateId = randomUUID();
    const candidateDirectory = resolve(this.workspacePath(workspaceId), 'candidates', candidateId, 'versions', '000');
    mkdirSync(candidateDirectory, { recursive: true, mode: 0o700 });
    this.writeWorkspaceFiles(candidateDirectory, files);
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
    this.atomicWrite(resolve(this.workspacePath(workspaceId), 'candidates', candidateId, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  candidate(workspaceId: string, candidateId: string, candidateVersion: number): WorkspaceCandidate | undefined {
    if (!this.get(workspaceId) || !this.isSafeCandidateId(candidateId) || !Number.isSafeInteger(candidateVersion) || candidateVersion < 0) return undefined;
    const root = resolve(this.workspacePath(workspaceId), 'candidates', candidateId);
    const raw = this.readOptionalFile(resolve(root, 'manifest.json'));
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
      const files = this.readWorkspaceFiles(resolve(root, 'versions', String(candidateVersion).padStart(3, '0')));
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
    const path = resolve(this.workspacePath(workspaceId), 'candidates', candidateId, 'manifest.json');
    const raw = this.readOptionalFile(path);
    if (!raw) return undefined;
    try {
      const manifest = JSON.parse(raw) as CandidateManifest;
      const attempts = Number.isSafeInteger(manifest.repairAttempts) && manifest.repairAttempts >= 0
        ? manifest.repairAttempts
        : 0;
      if (attempts >= maxAttempts) return undefined;
      const nextAttempt = attempts + 1;
      this.atomicWrite(path, JSON.stringify({ ...manifest, repairAttempts: nextAttempt }, null, 2));
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
    this.validateWorkspaceFiles(files);
    const nextVersion = expectedVersion + 1;
    const root = resolve(this.workspacePath(workspaceId), 'candidates', candidateId);
    const destination = resolve(root, 'versions', String(nextVersion).padStart(3, '0'));
    if (existsSync(destination)) throw new Error('候选下一版本已存在，拒绝覆盖');
    this.writeWorkspaceFiles(destination, files);
    const next: CandidateManifest = {
      ...current,
      candidateVersion: nextVersion,
      contentHash: this.contentHash(workspaceId, files),
      createdAt: new Date().toISOString(),
      status: 'active',
      repairAttempts: (current as CandidateManifest).repairAttempts ?? 0
    };
    this.atomicWrite(resolve(root, 'manifest.json'), JSON.stringify(next, null, 2));
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
    const files = this.readWorkspaceFiles(resolve(this.workspacePath(workspaceId), 'candidates', candidateId, 'versions', String(candidateVersion).padStart(3, '0')));
    const preview = this.previewHtmlFromFiles(workspaceId, files, manifest.renderMode, assetQuery, workspaceAssetPath, candidateAssetPath);
    if (!preview) return undefined;
    const marker = `<meta name="ui-agent-document-ref" data-workspace-id="${escapeHtmlAttribute(manifest.workspaceId)}" data-candidate-id="${escapeHtmlAttribute(manifest.candidateId)}" data-candidate-version="${manifest.candidateVersion}" data-content-hash="${escapeHtmlAttribute(manifest.contentHash)}" data-render-mode="${manifest.renderMode}">`;
    return /<\/head>/i.test(preview) ? preview.replace(/<\/head>/i, `${marker}\n</head>`) : `${marker}\n${preview}`;
  }

  candidateAuthorOverrides(workspaceId: string, candidateId: string, candidateVersion: number): string | undefined {
    const manifest = this.candidate(workspaceId, candidateId, candidateVersion);
    if (!manifest || manifest.status !== 'active') return undefined;
    const css = this.readOptionalFile(resolve(
      this.workspacePath(workspaceId), 'candidates', candidateId, 'versions', String(candidateVersion).padStart(3, '0'), 'author-overrides.css'
    ));
    if (css === undefined) return undefined;
    validateCss(css);
    return css;
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
    const directory = resolve(this.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'observations');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.atomicWrite(resolve(directory, `${observation.observationId}.json`), JSON.stringify(observation));
    return observation;
  }

  recordIntent(workspaceId: string, candidateId: string, candidateVersion: number, input: unknown): WorkspaceIntent {
    const intent = workspaceIntentSchema.parse(input);
    const candidate = this.candidate(workspaceId, candidateId, candidateVersion);
    if (!candidate || candidate.status !== 'active') throw new Error('候选版本不存在或已失效');
    const directory = resolve(this.workspacePath(workspaceId), 'candidates', candidateId, 'intents');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `${intent.intentId}.json`);
    const existing = this.readOptionalFile(path);
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
    this.atomicWrite(path, JSON.stringify(intent));
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
    const files = this.readWorkspaceFiles(resolve(this.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'versions', String(request.candidateVersion).padStart(3, '0')));
    let staticOk = false;
    let staticMessage = '';
    try {
      this.validateWorkspaceFiles(files);
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
    const directory = resolve(this.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'validations');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.atomicWrite(resolve(directory, `${record.validationId}.json`), JSON.stringify(record));
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
    const files = this.readWorkspaceFiles(resolve(this.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'versions', String(request.candidateVersion).padStart(3, '0')));
    const commitsDirectory = resolve(this.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'commits');
    mkdirSync(commitsDirectory, { recursive: true, mode: 0o700 });
    const pendingPath = resolve(commitsDirectory, `${request.commitId}.pending.json`);
    const pending = this.readOptionalFile(pendingPath);
    if (!pending) {
      // Persist the idempotency identity before changing the formal document.
      // If the process stops after commitWorkingCopy, a retry can recover the
      // receipt from the already-written revision instead of committing again.
      this.atomicWrite(pendingPath, JSON.stringify({ request, preparedAt: new Date().toISOString() }));
    }
    const manifest = this.readManifest(this.workspacePath(request.workspaceId));
    const recoveredRevision = request.baseRevision + 1;
    const recoveredFilesPath = resolve(this.workspacePath(request.workspaceId), 'revisions', String(recoveredRevision).padStart(3, '0'));
    if (manifest.revision === recoveredRevision && existsSync(resolve(recoveredFilesPath, 'index.html'))) {
      const recoveredFiles = this.readWorkspaceFiles(recoveredFilesPath);
      if (this.contentHash(request.workspaceId, recoveredFiles) === request.contentHash) {
        const recovered: CandidatePublishResult = {
          workspaceId: request.workspaceId, candidateId: request.candidateId, candidateVersion: request.candidateVersion,
          revision: recoveredRevision, committedAt: new Date().toISOString(), unchanged: false
        };
        this.atomicWrite(resolve(commitsDirectory, `${request.commitId}.json`), JSON.stringify(recovered));
        return recovered;
      }
    }
    if (manifest.revision !== request.baseRevision) throw new Error('正式版本已变化，候选基线过期');
    const revision = this.commitWorkingCopy(request.workspaceId, files, request.summary);
    const result: CandidatePublishResult = {
      workspaceId: request.workspaceId, candidateId: request.candidateId, candidateVersion: request.candidateVersion,
      revision, committedAt: new Date().toISOString(), unchanged: false
    };
    this.atomicWrite(resolve(commitsDirectory, `${request.commitId}.json`), JSON.stringify(result));
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
    const directory = resolve(this.workspacePath(request.workspaceId), 'candidates', request.candidateId, 'artifacts');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.atomicWrite(resolve(directory, `${artifact.artifactId}.png`), bytes);
    this.atomicWrite(resolve(directory, `${artifact.artifactId}.json`), JSON.stringify(artifact));
    return artifact;
  }

  renderArtifactMatches(document: Pick<RenderArtifact, 'workspaceId' | 'baseRevision' | 'candidateId' | 'candidateVersion' | 'contentHash' | 'renderMode' | 'jobId' | 'sampleId'>, observation: Pick<LiveWorkspaceObservation, 'viewport' | 'scroll'>, artifactId: string): boolean {
    if (!/^[0-9a-f-]{36}$/i.test(artifactId)) return false;
    const raw = this.readOptionalFile(resolve(this.workspacePath(document.workspaceId), 'candidates', document.candidateId, 'artifacts', `${artifactId}.json`));
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
    const raw = this.readOptionalFile(resolve(this.workspacePath(document.workspaceId), 'candidates', document.candidateId, 'artifacts', `${artifactId}.json`));
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
    const directory = this.workspacePath(workspaceId);
    return this.previewHtmlFromFiles(workspaceId, this.readWorkspaceFiles(directory), candidate, assetQuery);
  }

  private previewHtmlFromFiles(
    workspaceId: string,
    files: WorkspaceFiles,
    candidate: 'A' | 'B',
    assetQuery: string,
    workspaceAssetPath = '',
    candidateAssetPath = workspaceAssetPath
  ): string | undefined {
    const html = files['index.html'];
    const css = files['snapshot.css'];
    const authorOverrides = files['author-overrides.css'];
    const authorResources = this.authorStyleResources(workspaceId);
    const unreadableStyleSources = this.unreadableAuthorStyleSources(workspaceId);
    const authorSheets = this.authorStyleSheets(workspaceId);
    validateHtml(html);
    if (css) validateCss(css);
    if (authorOverrides) validateCss(authorOverrides);
    let previewCss = css;
    let style = `<style data-ui-agent-workspace-styles data-ui-agent-candidate="A">\n${previewCss}\n</style>`;
    if (candidate === 'B') {
      if (!this.hasAuthorRuleCandidate(workspaceId)) return undefined;
      // B intentionally has no frozen snapshot rules. The capture frame fixes
      // the page to the original viewport and causes overflow in responsive
      // layouts; computed classes would also override the author cascade.
      previewCss = '';
      const orderedStyleLinks = authorSheets.length
        ? authorSheets.map((sheet, index) => {
          const attributes = `${sheet.media ? ` media="${escapeHtmlAttribute(sheet.media)}"` : ''}${sheet.disabled ? ' disabled' : ''}`;
          return sheet.renderOnly
            ? `<link rel="stylesheet" href="${escapeHtmlAttribute(sheet.sourceUrl)}"${attributes} data-ui-agent-render-only-stylesheet>`
            : `<link rel="stylesheet" href="${workspaceAssetPath}author-sheets/${index}${assetQuery}"${attributes} data-ui-agent-author-styles data-ui-agent-candidate="B">`;
        }
        ).join('\n')
        : `${this.authorCss(workspaceId)
          ? `<link rel="stylesheet" href="${workspaceAssetPath}author.css${assetQuery}" data-ui-agent-author-styles data-ui-agent-candidate="B">`
          : ''}${unreadableStyleSources.map(source => `\n<link rel="stylesheet" href="${escapeHtmlAttribute(source)}" data-ui-agent-render-only-stylesheet>`).join('')}`;
      style = `${orderedStyleLinks}\n<link rel="stylesheet" href="${candidateAssetPath}author-overrides.css${assetQuery}" data-ui-agent-author-overrides>`;
    }
    const localizedHtml = this.localizeSnapshotResources(html, authorResources);
    return /<\/head>/i.test(localizedHtml)
      ? localizedHtml.replace(/<\/head>/i, `${style}\n</head>`)
      : localizedHtml.replace(/<body\b/i, `${style}\n<body`);
  }

  conversation(workspaceId: string): CodingAgentConversationTurn[] {
    const directory = this.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const manifest = this.readManifest(directory);
    return (manifest.conversation ?? [])
      .filter(turn => (turn.revision ?? 0) <= manifest.revision)
      .slice(-8)
      .map(({ instruction, result }) => ({ instruction, result }));
  }

  chat(workspaceId: string): WorkspaceChatEntry[] {
    const directory = this.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const manifest = this.readManifest(directory);
    return (manifest.chat ?? [])
      .filter(entry => entry.revision <= manifest.revision)
      .slice(-200);
  }

  appendChat(workspaceId: string, entry: WorkspaceChatEntry): void {
    const directory = this.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    const manifest = this.readManifest(directory);
    if (entry.revision > manifest.revision) {
      throw new Error('对话记录不能关联到尚未生成的副本版本');
    }
    if ((manifest.chat ?? []).some(item => item.id === entry.id)) return;
    this.writeManifest(directory, {
      ...manifest,
      updatedAt: new Date().toISOString(),
      chat: [...(manifest.chat ?? []), entry].slice(-200)
    });
  }

  recordTurn(workspaceId: string, request: SourceTurnRequest, response: SourceTurnResponse): void {
    // Candidate drafts are intentionally not mixed into the formal-revision
    // conversation history. M3 will add draft-session recovery separately.
    if (response.kind === 'draft') return;
    const directory = this.workspacePath(workspaceId);
    const manifest = this.readManifest(directory);
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
    this.writeManifest(directory, {
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
    const workspaceDirectory = this.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    if (this.active.has(workspaceId)) throw new Error('当前工作区已有正在执行的修改');
    const candidate = candidateInput && this.candidate(workspaceId, candidateInput.candidateId, candidateInput.candidateVersion);
    if (candidateInput && (!candidate || candidate.status !== 'active')) throw new Error('候选版本不存在或已失效');
    const directory = candidate
      ? resolve(workspaceDirectory, 'candidates', candidate.candidateId, 'versions', String(candidate.candidateVersion).padStart(3, '0'))
      : workspaceDirectory;
    this.active.add(workspaceId);
    const original = this.readWorkspaceFiles(directory);
    let working: WorkspaceFiles = { ...original };
    const authorRuleMode = this.hasAuthorRuleCandidate(workspaceId);
    const editableStylePath: 'snapshot.css' | 'author-overrides.css' = authorRuleMode
      ? 'author-overrides.css'
      : 'snapshot.css';
    const initial = candidate
      ? this.readWorkspaceFiles(directory)
      : this.readWorkspaceFiles(resolve(directory, 'revisions', '000'));
    const baselineVisibilityIssues = authorRuleMode
      ? new Set<string>()
      : new Set(analyzeStaticVisibility(initial['index.html'], initial['snapshot.css']).map(staticVisibilityIssueKey));
    let closed = false;
    const refreshIndexes = () => {
      const indexes = refreshWorkspaceIndexes(working['index.html']);
      working['outline.json'] = indexes.outline;
      working['source-map.json'] = indexes.sourceMap;
    };
    const validateWorking = () => {
      validateHtml(working['index.html']);
      validateCss(working[editableStylePath]);
      const newVisibilityIssues = authorRuleMode ? [] : analyzeStaticVisibility(
        working['index.html'],
        working['snapshot.css']
      ).filter(issue => !baselineVisibilityIssues.has(staticVisibilityIssueKey(issue)));
      if (newVisibilityIssues.length) {
        throw new Error(`静态可见性校验失败：${newVisibilityIssues.slice(0, 3).map(issue => issue.message).join('；')}。请调整父容器尺寸、overflow 或元素定位后重新校验。`);
      }
      return authorRuleMode
        ? 'HTML、author-overrides.css 与安全规则校验通过；原始规则模式仍需真实浏览器几何验证'
        : 'HTML、CSS、结构、安全与静态可见性规则校验通过';
    };
    const close = () => {
      if (closed) return;
      closed = true;
      this.active.delete(workspaceId);
    };
    const readableContent = (path: string): string => {
      if (path === 'author.css' && this.authorCss(workspaceId)) return this.authorCss(workspaceId)!;
      if (path === 'author-style-links.json' && authorRuleMode) return JSON.stringify(this.unreadableAuthorStyleSources(workspaceId), null, 2);
      this.assertReadablePath(path);
      const content = working[path as WorkspaceFile];
      return path === 'index.html' ? extractCapturedLayoutIndex(content).html : content;
    };

    let toolset!: CodingWorkspaceTools;
    toolset = {
      submissionMode: candidate ? 'candidate' : 'direct',
      listFiles: async () => [
        ...WORKSPACE_FILES.map(path => ({ path, chars: readableContent(path).length })),
        ...(this.authorCss(workspaceId) ? [{ path: 'author.css', chars: this.authorCss(workspaceId)!.length }] : []),
        ...(this.unreadableAuthorStyleSources(workspaceId).length
          ? [{ path: 'author-style-links.json', chars: JSON.stringify(this.unreadableAuthorStyleSources(workspaceId)).length }]
          : [])
      ],
      queryWorkspaceStructure: async (query, options = {}) => {
        const terms = structureQueryTerms(query);
        if (!terms.length) throw new Error('结构查询至少需要一个长度不少于 2 的语义词');
        const outline = JSON.parse(working['outline.json']) as { nodes: StructureNode[] };
        const selectedPath = options.selectedSourceId
          ? new Set(sourceElementAncestry(working['index.html'], options.selectedSourceId).map(item => item.sourceId))
          : new Set<string>();
        const scored = outline.nodes
          .map(node => {
            const searchable = `${node.text} ${node.role ?? ''} ${node.tag} ${node.classes.join(' ')}`.toLocaleLowerCase();
            const normalizedSearchable = normalizeStructureSearchText(searchable);
            const matchedTerms = terms.filter(term => (
              searchable.includes(term) || normalizedSearchable.includes(normalizeStructureSearchText(term))
            ));
            const selectedBoost = selectedPath.has(node.sourceId) ? 2 : 0;
            return { node, matchedTerms, score: matchedTerms.length * 10 + selectedBoost };
          })
          .filter(item => item.matchedTerms.length > 0)
          .sort((left, right) => right.score - left.score || left.node.depth - right.node.depth)
          .slice(0, Math.min(Math.max(options.limit ?? 8, 1), 12));
        if (!scored.length) {
          return `结构索引中未找到与“${query}”匹配的元素。请缩短或更换语义词；只有必要时再使用 search_text 搜索源码。`;
        }
        return JSON.stringify({
          query,
          terms,
          selectedSourceId: options.selectedSourceId,
          candidates: scored.map(item => ({
            matchedTerms: item.matchedTerms,
            score: item.score,
            ...structureNeighborhood(outline.nodes, item.node.sourceId)
          }))
        }, null, 2);
      },
      searchText: async (query, path = 'index.html') => {
        const content = readableContent(path);
        const matches: Array<{ index: number; contextStart: number; contextEnd: number }> = [];
        let offset = 0;
        while (matches.length < 10) {
          const index = content.indexOf(query, offset);
          if (index < 0) break;
          matches.push({
            index,
            contextStart: Math.max(0, index - 600),
            contextEnd: Math.min(content.length, index + query.length + 600)
          });
          offset = index + Math.max(1, query.length);
        }
        return matches.length
          ? matches.map((item, matchIndex) => [
            `${path} 匹配 ${matchIndex + 1}：命中字符 ${item.index}，建议读取 startChar=${item.contextStart}, endChar=${item.contextEnd}`,
            content.slice(item.contextStart, item.contextEnd)
          ].join('\n')).join('\n\n')
          : `${path} 中没有找到“${query}”`;
      },
      readFile: async (path, startLine = 1, endLine, startChar, endChar) => {
        const content = readableContent(path);
        if (startChar !== undefined || endChar !== undefined) {
          const start = Math.max(0, startChar ?? 0);
          const end = Math.min(content.length, endChar ?? start + 16_000);
          if (end <= start) throw new Error('读取结束字符必须大于开始字符');
          if (end - start > 20_000) throw new Error('单次最多读取 20000 个字符');
          return `${path} 字符 ${start}-${end}：\n${content.slice(start, end)}`;
        }
        const lines = content.split('\n');
        const start = Math.max(1, startLine);
        const end = Math.min(lines.length, Math.max(start, endLine ?? start + 119));
        return lines.slice(start - 1, end)
          .map((line, index) => `${start + index}: ${line}`)
          .join('\n')
          .slice(0, 16_000);
      },
      inspectElement: async (sourceId, options = {}) => {
        const html = working['index.html'];
        const full = options.detail === 'full';
        const range = sourceElementRange(html, sourceId);
        const ancestry = sourceElementAncestry(html, sourceId);
        const outline = JSON.parse(working['outline.json']) as {
          nodes: Array<{
            sourceId: string;
            parentSourceId?: string;
            childrenSourceIds: string[];
          }>;
        };
        const node = outline.nodes.find(item => item.sourceId === sourceId);
        const parent = node?.parentSourceId
          ? outline.nodes.find(item => item.sourceId === node.parentSourceId)
          : undefined;
        const siblingIds = (parent?.childrenSourceIds ?? [])
          .filter(candidate => candidate !== sourceId)
          .slice(0, 12);
        const layoutIndex = this.capturedLayoutIndex(workspaceId, html);
        const layoutContext = {
          target: sourceLayoutFacts(html, working['snapshot.css'], layoutIndex, sourceId, full ? 'full' : 'target'),
          children: (node?.childrenSourceIds ?? []).slice(0, full ? 8 : 6).map(child => sourceLayoutFacts(html, working['snapshot.css'], layoutIndex, child, full ? 'full' : 'context')),
          ancestors: ancestry
            .slice(0, -1)
            .slice(full ? -6 : -4)
            .reverse()
            .map(item => sourceLayoutFacts(html, working['snapshot.css'], layoutIndex, item.sourceId, full ? 'full' : 'context')),
          siblings: siblingIds.slice(0, full ? 12 : 6).map(candidate => sourceLayoutFacts(
            html,
            working['snapshot.css'],
            layoutIndex,
            candidate,
            full ? 'full' : 'context'
          ))
        };
        return [
          `元素 ${sourceId}：tag=${range.tag}，字符 ${range.start}-${range.end}`,
          `结构路径: ${ancestry.map(item => `${item.sourceId}<${item.tag}>`).join(' > ')}`,
          `布局上下文: ${JSON.stringify(layoutContext)}`,
          compactElementSource(html.slice(range.start, range.end), full ? 12_000 : 4_000)
        ].join('\n');
      },
      queryStyleSymbols: async symbols => {
        const sources: Array<{ path: string; content: string }> = authorRuleMode
          ? [
              { path: 'author.css', content: this.authorCss(workspaceId) ?? '' },
              { path: 'author-overrides.css', content: working['author-overrides.css'] }
            ]
          : [{ path: 'snapshot.css', content: working['snapshot.css'] }];
        const sections = symbols.map(rawSymbol => {
          const symbol = rawSymbol.trim();
          if (!/^(?:\.?[a-zA-Z_][\w-]{0,119}|--[a-zA-Z_][\w-]{0,117})$/.test(symbol)) {
            throw new Error(`样式符号格式无效：${rawSymbol}`);
          }
          const variable = symbol.startsWith('--');
          const className = symbol.replace(/^\./, '');
          const matches = sources.flatMap(source => {
            const values = variable
              ? cssSnippetsForSymbol(source.content, symbol)
              : cssRulesForClass(source.content, className).slice(0, 6);
            return values.map(value => `${source.path}: ${value}`);
          });
          return matches.length
            ? `${symbol}：\n${matches.join('\n')}`
            : `${symbol}：未找到可读取的样式定义或引用`;
        });
        const result = sections.join('\n\n---\n\n');
        return result.length <= 12_000
          ? result
          : `[样式查询已按总预算截断] 原始 ${result.length} 字符，仅返回前 12000 字符。\n\n${result.slice(0, 12_000)}`;
      },
      readStyleRule: async rawClassName => {
        const className = rawClassName.replace(/^\./, '');
        if (!/^[a-zA-Z0-9_-]{1,120}$/.test(className)) {
          throw new Error('样式类名格式无效，请传入 inspect_element 返回的单个 class 名');
        }
        // In B mode only the editable override layer can have been changed by
        // this turn. Spatial validation reads that layer to reject new fixed
        // positioning without treating immutable author.css as editable.
        const stylePath = authorRuleMode ? 'author-overrides.css' : 'snapshot.css';
        const rules = cssRulesForClass(working[stylePath], className);
        if (!rules.length) throw new Error(`${stylePath} 中不存在 .${className} 规则`);
        return `${stylePath} 中 .${className} 命中的 ${rules.length} 条规则（含组合选择器和伪类状态）：\n${rules.join('\n').slice(0, 16_000)}`;
      },
      replaceText: async (path, search, replacement) => {
        this.assertEditablePath(path, editableStylePath);
        const file = path as Extract<WorkspaceFile, 'index.html' | 'snapshot.css' | 'author-overrides.css'>;
        const content = working[file];
        const occurrences = countOccurrences(content, search);
        if (occurrences !== 1) {
          throw new Error(occurrences === 0
            ? '替换原文与当前文件不匹配，请重新读取相关片段'
            : `替换原文出现 ${occurrences} 次，请提供更完整的唯一上下文`);
        }
        const next = content.replace(search, replacement);
        if (file === 'index.html') {
          validateHtml(next);
          working[file] = next;
          refreshIndexes();
        } else {
          validateCss(next);
          working[file] = next;
        }
        return `替换成功；${file} 当前 ${next.length} 字符；工作区校验通过`;
      },
      applyPatch: async (path, edits) => {
        this.assertEditablePath(path, editableStylePath);
        if (edits.length < 1 || edits.length > 20) throw new Error('Patch 必须包含 1-20 个编辑操作');
        const file = path as Extract<WorkspaceFile, 'index.html' | 'snapshot.css' | 'author-overrides.css'>;
        let next = working[file];
        for (const [index, edit] of edits.entries()) {
          if (edit.kind === 'replace') {
            if (!edit.search) throw new Error(`Patch 第 ${index + 1} 项的 search 不能为空`);
            if (typeof edit.replace !== 'string') throw new Error(`Patch 第 ${index + 1} 项的 replace 必须是字符串`);
            const occurrences = countOccurrences(next, edit.search);
            if (occurrences !== 1) {
              throw new Error(occurrences === 0
                ? `Patch 第 ${index + 1} 项的替换原文与当前文件不匹配`
                : `Patch 第 ${index + 1} 项的替换原文出现 ${occurrences} 次`);
            }
            next = next.replace(edit.search, edit.replace);
            continue;
          }
          if (typeof edit.text !== 'string' || !edit.text) {
            throw new Error(`Patch 第 ${index + 1} 项的插入内容不能为空`);
          }
          if (edit.position === 'start') {
            next = `${edit.text}${next}`;
            continue;
          }
          if (edit.position === 'end') {
            next = `${next}${edit.text}`;
            continue;
          }
          if (!edit.anchor) throw new Error(`Patch 第 ${index + 1} 项必须提供 anchor`);
          const occurrences = countOccurrences(next, edit.anchor);
          if (occurrences !== 1) {
            throw new Error(occurrences === 0
              ? `Patch 第 ${index + 1} 项的插入锚点与当前文件不匹配`
              : `Patch 第 ${index + 1} 项的插入锚点出现 ${occurrences} 次`);
          }
          const anchorIndex = next.indexOf(edit.anchor);
          const insertionIndex = edit.position === 'before'
            ? anchorIndex
            : anchorIndex + edit.anchor.length;
          next = `${next.slice(0, insertionIndex)}${edit.text}${next.slice(insertionIndex)}`;
        }
        if (file === 'index.html') {
          validateHtml(next);
          working[file] = next;
          refreshIndexes();
        } else {
          validateCss(next);
          working[file] = next;
        }
        return `Patch 成功应用 ${edits.length} 项；${file} 当前 ${next.length} 字符；工作区校验通过`;
      },
      replaceInElement: async (sourceId, search, replacement) => {
        const html = working['index.html'];
        const range = sourceElementRange(html, sourceId);
        const outerHtml = html.slice(range.start, range.end);
        const occurrences = countOccurrences(outerHtml, search);
        if (occurrences !== 1) {
          throw new Error(occurrences === 0
            ? `替换原文不在元素 ${sourceId} 内，请先 inspect 该元素并使用 rawTextSegments 中的精确原文`
            : `替换原文在元素 ${sourceId} 内出现 ${occurrences} 次，请提供更完整的唯一上下文`);
        }
        const updatedElement = outerHtml.replace(search, replacement);
        const next = `${html.slice(0, range.start)}${updatedElement}${html.slice(range.end)}`;
        validateHtml(next);
        working['index.html'] = next;
        refreshIndexes();
        return `元素 ${sourceId} 内替换成功；HTML 与安全规则校验通过`;
      },
      setElementText: async (sourceId, text) => {
        const html = working['index.html'];
        const range = sourceElementRange(html, sourceId);
        const inner = sourceElementInnerRange(html, range);
        const removedSourceIds = [...html.slice(inner.start, inner.end).matchAll(
          /\bdata-ui-source-id\s*=\s*["']([^"']+)["']/gi
        )].map(match => match[1]!);
        const next = `${html.slice(0, inner.start)}${escapeHtmlText(text)}${html.slice(inner.end)}`;
        validateHtml(next);
        working['index.html'] = next;
        working[editableStylePath] = withoutSourceScopedCss(working[editableStylePath], removedSourceIds);
        validateCss(working[editableStylePath]);
        refreshIndexes();
        return `元素 ${sourceId} 的文本内容已设置；${removedSourceIds.length} 个原后代元素已移除；HTML、CSS 与安全规则校验通过`;
      },
      setElementAttributes: async (sourceId, set, remove) => {
        if (!Object.keys(set).length && !remove.length) throw new Error('属性操作不能为空');
        const html = working['index.html'];
        const range = sourceElementRange(html, sourceId);
        const openingEnd = findTagEnd(html, range.start);
        const openingTag = html.slice(range.start, openingEnd + 1);
        const updatedTag = updateOpeningTagAttributes(openingTag, set, remove);
        const next = `${html.slice(0, range.start)}${updatedTag}${html.slice(openingEnd + 1)}`;
        validateHtml(next);
        working['index.html'] = next;
        refreshIndexes();
        return `元素 ${sourceId} 的属性已更新（设置 ${Object.keys(set).length} 项，删除 ${remove.length} 项）；HTML 与安全规则校验通过`;
      },
      insertElement: async (targetSourceId, position, fragmentHtml, options) => {
        const html = working['index.html'];
        const fragment = fragmentWithFreshSourceIds(html, fragmentHtml);
        const insertionHtml = options?.styleReferenceSourceId && !authorRuleMode
          ? applyFrozenReferenceStyles(
            fragment.html,
            fragment.rootSourceIds,
            html,
            options.styleReferenceSourceId
          )
          : fragment.html;
        const targetRange = sourceElementRange(html, targetSourceId);
        let insertionIndex: number;
        if (position === 'parentStart') {
          insertionIndex = findTagEnd(html, targetRange.start) + 1;
        } else if (position === 'parentEnd') {
          insertionIndex = elementClosingTagStart(html, targetRange);
        } else {
          insertionIndex = position === 'before' ? targetRange.start : targetRange.end;
        }
        const next = `${html.slice(0, insertionIndex)}${insertionHtml}${html.slice(insertionIndex)}`;
        validateHtml(next);
        working['index.html'] = next;
        refreshIndexes();
        return `已在元素 ${targetSourceId} 的 ${position} 位置插入 ${fragment.rootSourceIds.length} 个顶层元素：${fragment.rootSourceIds.join(', ')}${options?.styleReferenceSourceId && !authorRuleMode ? `；已复制 ${options.styleReferenceSourceId} 的冻结计算样式作为布局参照` : ''}；HTML、结构与安全规则校验通过`;
      },
      wrapElement: async (sourceId, tagName, attributes) => {
        const html = working['index.html'];
        const range = sourceElementRange(html, sourceId);
        const wrapperSourceId = `source-${nextSourceNumber(html)}`;
        const openingTag = wrapperOpeningTag(tagName, wrapperSourceId, attributes);
        const outerHtml = html.slice(range.start, range.end);
        const wrapped = `${openingTag}${outerHtml}</${tagName}>`;
        const next = `${html.slice(0, range.start)}${wrapped}${html.slice(range.end)}`;
        validateHtml(next);
        working['index.html'] = next;
        refreshIndexes();
        return `元素 ${sourceId} 已由新容器 ${wrapperSourceId}<${tagName.toLowerCase()}> 包裹；HTML、结构与安全规则校验通过`;
      },
      unwrapElement: async sourceId => {
        const html = working['index.html'];
        const range = sourceElementRange(html, sourceId);
        const inner = sourceElementInnerRange(html, range);
        const innerHtml = html.slice(inner.start, inner.end);
        const next = `${html.slice(0, range.start)}${innerHtml}${html.slice(range.end)}`;
        validateHtml(next);
        working['index.html'] = next;
        working[editableStylePath] = withoutSourceScopedCss(working[editableStylePath], [sourceId]);
        validateCss(working[editableStylePath]);
        refreshIndexes();
        return `容器元素 ${sourceId} 已解除包裹，其原有子节点保留在原位置；HTML、CSS、结构与安全规则校验通过`;
      },
      removeElement: async sourceId => {
        const html = working['index.html'];
        const range = sourceElementRange(html, sourceId);
        const removedHtml = html.slice(range.start, range.end);
        const removedSourceIds = [...removedHtml.matchAll(
          /\bdata-ui-source-id\s*=\s*["']([^"']+)["']/gi
        )].map(match => match[1]!);
        const next = `${html.slice(0, range.start)}${html.slice(range.end)}`;
        validateHtml(next);
        working['index.html'] = next;
        working[editableStylePath] = withoutSourceScopedCss(working[editableStylePath], removedSourceIds);
        validateCss(working[editableStylePath]);
        refreshIndexes();
        return `元素 ${sourceId} 已完整删除；其 ${Math.max(0, removedSourceIds.length - 1)} 个后代节点及对应 sourceId 专属样式已同步移除；HTML、CSS、结构与安全规则校验通过`;
      },
      reorderChildren: async (parentSourceId, orderedSourceIds) => {
        if (new Set(orderedSourceIds).size !== orderedSourceIds.length) throw new Error('排序列表包含重复 sourceId');
        const html = working['index.html'];
        const parentRange = sourceElementRange(html, parentSourceId);
        const parentInner = sourceElementInnerRange(html, parentRange);
        const outline = JSON.parse(working['outline.json']) as {
          nodes: Array<{ sourceId: string; childrenSourceIds: string[] }>;
        };
        const directChildren = outline.nodes.find(node => node.sourceId === parentSourceId)?.childrenSourceIds ?? [];
        if (
          directChildren.length !== orderedSourceIds.length
          || directChildren.some(sourceId => !orderedSourceIds.includes(sourceId))
        ) {
          throw new Error(`orderedSourceIds 必须恰好包含父元素 ${parentSourceId} 的全部直接 source 子节点`);
        }
        const ranges = directChildren
          .map(sourceId => ({ sourceId, ...sourceElementRange(html, sourceId) }))
          .sort((left, right) => left.start - right.start);
        const outerById = new Map(ranges.map(range => [range.sourceId, html.slice(range.start, range.end)]));
        const gaps: string[] = [];
        let cursor = parentInner.start;
        for (const range of ranges) {
          gaps.push(html.slice(cursor, range.start));
          cursor = range.end;
        }
        gaps.push(html.slice(cursor, parentInner.end));
        const reorderedInner = orderedSourceIds
          .map((sourceId, index) => `${gaps[index]}${outerById.get(sourceId)!}`)
          .join('') + gaps.at(-1)!;
        const next = `${html.slice(0, parentInner.start)}${reorderedInner}${html.slice(parentInner.end)}`;
        if (next === html) throw new Error('子节点已经是指定顺序');
        validateHtml(next);
        working['index.html'] = next;
        refreshIndexes();
        return `父元素 ${parentSourceId} 的 ${orderedSourceIds.length} 个直接子节点已按指定顺序重排；HTML、结构与安全规则校验通过`;
      },
      moveElement: async (sourceId, position, targetSourceId) => {
        const html = working['index.html'];
        const sourceRange = sourceElementRange(html, sourceId);
        const sourceAncestry = sourceElementAncestry(html, sourceId);
        const parent = sourceAncestry.at(-2);
        const outerHtml = html.slice(sourceRange.start, sourceRange.end);
        const withoutSource = `${html.slice(0, sourceRange.start)}${html.slice(sourceRange.end)}`;
        let insertionIndex: number;
        let destination: string;

        if (position === 'parentStart' || position === 'parentEnd') {
          if (!parent) throw new Error(`元素 ${sourceId} 没有可编辑的父容器`);
          const parentRange = sourceElementRange(withoutSource, parent.sourceId);
          if (position === 'parentStart') {
            insertionIndex = findTagEnd(withoutSource, parentRange.start) + 1;
          } else {
            insertionIndex = elementClosingTagStart(withoutSource, parentRange);
          }
          destination = `父容器 ${parent.sourceId} 的${position === 'parentStart' ? '开头' : '末尾'}`;
        } else {
          if (!targetSourceId) throw new Error(`${position} 移动必须提供 targetSourceId`);
          if (targetSourceId === sourceId) throw new Error('不能相对于元素自身移动');
          const targetRange = sourceElementRange(withoutSource, targetSourceId);
          insertionIndex = position === 'before' ? targetRange.start : targetRange.end;
          destination = `元素 ${targetSourceId} 的${position === 'before' ? '前面' : '后面'}`;
        }

        const next = `${withoutSource.slice(0, insertionIndex)}${outerHtml}${withoutSource.slice(insertionIndex)}`;
        if (next === html) throw new Error(`元素 ${sourceId} 已位于指定位置`);
        validateHtml(next);
        working['index.html'] = next;
        refreshIndexes();
        return `元素 ${sourceId} 已完整移动到${destination}；原始结构和样式保持不变；HTML 与安全规则校验通过`;
      },
      cloneElement: async (templateSourceId, position, targetSourceId, replacements = []) => {
        const html = working['index.html'];
        const templateRange = sourceElementRange(html, templateSourceId);
        const templateAncestry = sourceElementAncestry(html, templateSourceId);
        const templateParent = templateAncestry.at(-2);
        let clonedHtml = html.slice(templateRange.start, templateRange.end);

        for (const replacement of replacements) {
          const occurrences = countOccurrences(clonedHtml, replacement.search);
          if (occurrences !== 1) {
            throw new Error(occurrences === 0
              ? `模板元素 ${templateSourceId} 中不存在替换原文“${replacement.search}”`
              : `替换原文“${replacement.search}”在模板元素中出现 ${occurrences} 次，请提供更完整的唯一上下文`);
          }
          clonedHtml = clonedHtml.replace(replacement.search, replacement.replace);
        }

        const clone = cloneWithFreshSourceIds(html, clonedHtml);
        const clonedScopedCss = clonedSourceScopedCss(working[editableStylePath], clone.sourceIdMap);
        let base = html;
        let insertionIndex: number;
        let destination: string;

        if (position === 'replace') {
          if (!targetSourceId) throw new Error('replace 克隆必须提供 targetSourceId');
          const targetRange = sourceElementRange(base, targetSourceId);
          base = `${base.slice(0, targetRange.start)}${base.slice(targetRange.end)}`;
          insertionIndex = targetRange.start;
          destination = `并替换元素 ${targetSourceId}`;
        } else if (position === 'parentStart' || position === 'parentEnd') {
          if (!templateParent) throw new Error(`模板元素 ${templateSourceId} 没有可编辑的父容器`);
          const parentRange = sourceElementRange(base, templateParent.sourceId);
          insertionIndex = position === 'parentStart'
            ? findTagEnd(base, parentRange.start) + 1
            : elementClosingTagStart(base, parentRange);
          destination = `到父容器 ${templateParent.sourceId} 的${position === 'parentStart' ? '开头' : '末尾'}`;
        } else {
          if (!targetSourceId) throw new Error(`${position} 克隆必须提供 targetSourceId`);
          const targetRange = sourceElementRange(base, targetSourceId);
          insertionIndex = position === 'before' ? targetRange.start : targetRange.end;
          destination = `到元素 ${targetSourceId} 的${position === 'before' ? '前面' : '后面'}`;
        }

        const next = `${base.slice(0, insertionIndex)}${clone.html}${base.slice(insertionIndex)}`;
        validateHtml(next);
        working['index.html'] = next;
        working[editableStylePath] = [
          working[editableStylePath].trimEnd(),
          clonedScopedCss
        ].filter(Boolean).join('\n') + '\n';
        validateCss(working[editableStylePath]);
        refreshIndexes();
        return `已从模板 ${templateSourceId} 完整克隆元素 ${clone.rootSourceId}${destination}；结构与${authorRuleMode ? '可编辑覆盖样式' : '冻结样式'}已同步；HTML、CSS 与安全规则校验通过`;
      },
      applyDomOperations: async operations => {
        if (!operations.length || operations.length > 20) throw new Error('批量 DOM 操作必须包含 1-20 项');
        const before = { ...working };
        const results: string[] = [];
        try {
          for (const operation of operations) {
            const result = operation.kind === 'setText'
              ? await toolset.setElementText(operation.sourceId, operation.text)
              : operation.kind === 'setAttributes'
                ? await toolset.setElementAttributes(operation.sourceId, operation.set, operation.remove)
                : operation.kind === 'insert'
                  ? await toolset.insertElement(operation.targetSourceId, operation.position, operation.html)
                  : operation.kind === 'wrap'
                    ? await toolset.wrapElement(operation.sourceId, operation.tagName, operation.attributes)
                    : operation.kind === 'unwrap'
                      ? await toolset.unwrapElement(operation.sourceId)
                      : operation.kind === 'remove'
                        ? await toolset.removeElement(operation.sourceId)
                        : operation.kind === 'move'
                          ? await toolset.moveElement(operation.sourceId, operation.position, operation.targetSourceId)
                          : operation.kind === 'clone'
                            ? await toolset.cloneElement(
                              operation.templateSourceId,
                              operation.position,
                              operation.targetSourceId,
                              operation.replacements
                            )
                            : await toolset.reorderChildren(
                              operation.parentSourceId,
                              operation.orderedSourceIds
                            );
            results.push(result);
          }
          validateWorking();
          return `已原子应用 ${operations.length} 项 DOM 操作并完成统一校验：\n${results.map((result, index) => `${index + 1}. ${result}`).join('\n')}`;
        } catch (error) {
          working = before;
          throw new Error(`批量 DOM 操作已全部回滚：${error instanceof Error ? error.message : String(error)}`);
        }
      },
      validate: async () => validateWorking(),
      commit: async (summary, options = {}) => {
        if (working['index.html'] === original['index.html'] && working[editableStylePath] === original[editableStylePath]) {
          if (!options.allowNoChanges) throw new Error('Agent 没有对静态源码产生修改');
          validateWorking();
          const revision = this.readManifest(workspaceDirectory).revision;
          close();
          return candidate ? {
            revision, changed: false,
            candidate
          } : { revision, changed: false };
        }
        validateWorking();
        if (candidate) {
          const updated = this.updateCandidateFiles(workspaceId, candidate.candidateId, candidate.candidateVersion, working);
          close();
          return { revision: updated.baseRevision, changed: true, candidate: updated };
        }
        const revision = this.commitWorkingCopy(workspaceId, working, summary);
        close();
        return { revision, changed: true };
      },
      rollback: async () => close()
    };
    return toolset;
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
    const directory = this.workspacePath(workspaceId);
    const manifest = this.readManifest(directory);
    const files = this.readWorkspaceFiles(resolve(directory, 'revisions', '000'));
    this.validateWorkspaceFiles(files);
    this.writeWorkspaceFiles(directory, files, true);
    this.writeManifest(directory, { ...manifest, revision: 0, updatedAt: new Date().toISOString() });
    return this.get(workspaceId)!;
  }

  private commitWorkingCopy(workspaceId: string, files: WorkspaceFiles, summary: string): number {
    const directory = this.workspacePath(workspaceId);
    const manifest = this.readManifest(directory);
    this.validateWorkspaceFiles(files);
    const revision = manifest.revision + 1;
    const revisionsRoot = resolve(directory, 'revisions');
    for (const entry of readdirSync(revisionsRoot)) {
      const value = Number(entry);
      if (Number.isInteger(value) && value >= revision) rmSync(resolve(revisionsRoot, entry), { recursive: true, force: true });
    }
    const revisionDirectory = resolve(revisionsRoot, String(revision).padStart(3, '0'));
    mkdirSync(revisionDirectory, { recursive: true, mode: 0o700 });
    this.writeWorkspaceFiles(revisionDirectory, files);
    this.writeWorkspaceFiles(directory, files, true);
    const now = new Date().toISOString();
    this.writeManifest(directory, {
      ...manifest,
      updatedAt: now,
      revision,
      maxRevision: revision,
      summaries: [
        ...manifest.summaries.filter(item => item.revision < revision),
        { revision, summary, timestamp: now }
      ]
    });
    return revision;
  }

  private restore(workspaceId: string, direction: -1 | 1): SourceWorkspace {
    if (this.active.has(workspaceId)) throw new Error('Agent 修改执行期间不能撤销或重做');
    const directory = this.workspacePath(workspaceId);
    const manifest = this.readManifest(directory);
    const target = manifest.revision + direction;
    if (target < 0 || target > manifest.maxRevision) throw new Error(direction < 0 ? '没有可撤销的版本' : '没有可重做的版本');
    const source = resolve(directory, 'revisions', String(target).padStart(3, '0'));
    const files = this.readWorkspaceFiles(source);
    this.validateWorkspaceFiles(files);
    this.writeWorkspaceFiles(directory, files, true);
    this.writeManifest(directory, { ...manifest, revision: target, updatedAt: new Date().toISOString() });
    return this.get(workspaceId)!;
  }

  private assertEditablePath(path: string, editableStylePath: 'snapshot.css' | 'author-overrides.css') {
    if (path !== 'index.html' && path !== editableStylePath) {
      throw new Error(`源码 Agent 当前只能修改 index.html 或 ${editableStylePath}，拒绝路径 ${path}`);
    }
  }

  private assertReadablePath(path: string): asserts path is WorkspaceFile {
    if (!WORKSPACE_FILES.includes(path as WorkspaceFile)) {
      throw new Error(`源码 Agent 不能访问工作区文件 ${path}`);
    }
  }

  private readWorkspaceFiles(directory: string): WorkspaceFiles {
    const html = readFileSync(resolve(directory, 'index.html'), 'utf8');
    const css = this.readOptionalFile(resolve(directory, 'snapshot.css')) ?? '';
    const generated = refreshWorkspaceIndexes(html);
    return {
      'index.html': html,
      'snapshot.css': css,
      'author-overrides.css': this.readOptionalFile(resolve(directory, 'author-overrides.css')) ?? '',
      'outline.json': this.readOptionalFile(resolve(directory, 'outline.json')) ?? generated.outline,
      'source-map.json': this.readOptionalFile(resolve(directory, 'source-map.json')) ?? generated.sourceMap
    };
  }

  private capturedLayoutIndex(workspaceId: string, html: string): CapturedLayoutIndex {
    const stored = this.readOptionalFile(resolve(this.workspacePath(workspaceId), LAYOUT_INDEX_FILE));
    if (stored) {
      try {
        const parsed = staticSnapshotSchema.shape.layoutIndex.safeParse(JSON.parse(stored));
        if (parsed.success) return parsed.data ?? {};
      } catch { /* Fall through to legacy inline metadata. */ }
    }
    return extractCapturedLayoutIndex(html).layoutIndex;
  }

  private writeWorkspaceFiles(directory: string, files: WorkspaceFiles, atomic = false): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const path of WORKSPACE_FILES) {
      const target = resolve(directory, path);
      if (atomic) this.atomicWrite(target, files[path]);
      else writeFileSync(target, files[path], { encoding: 'utf8', mode: 0o600 });
    }
  }

  private validateWorkspaceFiles(files: WorkspaceFiles): void {
    validateHtml(files['index.html']);
    validateCss(files['snapshot.css']);
    validateCss(files['author-overrides.css']);
    JSON.parse(files['outline.json']);
    JSON.parse(files['source-map.json']);
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
      hash.update(this.readOptionalFile(resolve(this.workspacePath(workspaceId), path)) ?? '', 'utf8');
      hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
  }

  private isSafeCandidateId(candidateId: string): boolean {
    return /^[0-9a-f-]{36}$/i.test(candidateId);
  }

  private readCandidateJson<T>(workspaceId: string, candidateId: string, category: 'intents' | 'observations' | 'validations' | 'commits', id: string): T | undefined {
    if (!this.isSafeCandidateId(candidateId) || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const raw = this.readOptionalFile(resolve(this.workspacePath(workspaceId), 'candidates', candidateId, category, `${id}.json`));
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

  private readOptionalFile(path: string): string | undefined {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }

  private workspacePath(workspaceId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error('无效的 Workspace ID');
    const directory = resolve(this.root, workspaceId);
    if (!directory.startsWith(`${this.root}${sep}`)) throw new Error('Workspace 路径越界');
    return directory;
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

  private readManifest(directory: string): WorkspaceManifest {
    const manifest = JSON.parse(readFileSync(resolve(directory, 'workspace.json'), 'utf8')) as WorkspaceManifest;
    if (!manifest.conversation?.some(turn => turn.revision === undefined)) return manifest;

    // Workspace V2 initially stored conversations without a revision. Recover completed
    // turn revisions by matching their persisted summaries; clarification turns inherit
    // the latest known revision. This keeps existing workspaces undo-aware.
    const summaries = manifest.summaries.filter(item => item.revision > 0);
    let latestRevision = 0;
    const used = new Set<number>();
    return {
      ...manifest,
      conversation: manifest.conversation.map(turn => {
        if (turn.revision !== undefined) {
          latestRevision = Math.max(latestRevision, turn.revision);
          return turn;
        }
        const summary = summaries.find(item => !used.has(item.revision) && (
          turn.result.startsWith(item.summary) || item.summary.startsWith(turn.result)
        ));
        if (summary) {
          used.add(summary.revision);
          latestRevision = summary.revision;
        }
        return { ...turn, revision: latestRevision };
      })
    };
  }

  private writeManifest(directory: string, manifest: WorkspaceManifest) {
    this.atomicWrite(resolve(directory, 'workspace.json'), JSON.stringify(manifest, null, 2));
  }

  private atomicWrite(path: string, content: string | Uint8Array) {
    const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    if (typeof content === 'string') writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    else writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  }
}
