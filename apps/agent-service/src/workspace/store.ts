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
import { randomUUID } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { type CodingAgentConversationTurn, type CodingWorkspaceTools } from '@ui-agent/agent-runtime';
import {
  PROTOCOL_VERSION,
  staticSnapshotSchema,
  MAX_STATIC_SNAPSHOT_HTML_CHARS,
  type SnapshotMetrics,
  type StaticSnapshot,
  type SourceTurnRequest,
  type SourceTurnResponse
} from '@ui-agent/contracts';
import { compileSourceWorkspace, refreshWorkspaceIndexes } from './compiler';
import { validateControlledInteractions } from './interactions';
import { analyzeStaticVisibility, staticVisibilityIssueKey } from './visibility';

const WORKSPACE_FILES = ['index.html', 'snapshot.css', 'outline.json', 'source-map.json'] as const;
type WorkspaceFile = typeof WORKSPACE_FILES[number];
type WorkspaceFiles = Record<WorkspaceFile, string>;

const UNSAFE_HTML_RULES = [
  { label: '活动或嵌入式标签', pattern: /<\s*(script|iframe|frame|object|embed|base)\b/i },
  { label: '外部样式链接', pattern: /<\s*link\b/i },
  { label: 'HTTP Meta 指令', pattern: /<\s*meta\b[^>]*\bhttp-equiv\s*=/i },
  { label: 'DOM 事件属性', pattern: /\son[a-z]+\s*=/i },
  { label: 'srcdoc 嵌入内容', pattern: /\ssrcdoc\s*=/i },
  { label: 'javascript URL', pattern: /\bjavascript\s*:/i },
  { label: 'CSS @import', pattern: /@import\b/i },
  {
    label: 'HTTP/HTTPS 外部资源属性',
    pattern: /\s(?:src|srcset|href|action|formaction|poster)\s*=\s*["']?\s*(?:https?:|\/\/)/i
  }
];

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
}

function validateHtml(html: string): string {
  if (!/<!doctype html>/i.test(html) || !/<html\b/i.test(html) || !/<body\b/i.test(html)) {
    throw new Error('index.html 缺少完整的 doctype、html 或 body 结构');
  }
  const unsafe = UNSAFE_HTML_RULES.find(rule => rule.pattern.test(html));
  if (unsafe) throw new Error(`源码包含脚本、事件、远程资源或其他不安全内容（检测到：${unsafe.label}）`);
  const cssUrls = html.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi);
  for (const match of cssUrls) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim().toLowerCase();
    if (target.startsWith('#') || target.startsWith('data:')) continue;
    throw new Error('源码包含脚本、事件、远程资源或其他不安全内容（检测到：CSS 外部 url()）');
  }
  validateTableStructure(html);
  validateControlledInteractions(html);
  if (html.length > MAX_STATIC_SNAPSHOT_HTML_CHARS) {
    throw new Error(`index.html 超过 ${Math.round(MAX_STATIC_SNAPSHOT_HTML_CHARS / 1_000_000)} MB 限制`);
  }
  return 'HTML 与安全规则校验通过';
}

function validateCss(css: string): string {
  if (css.length > 10_000_000) throw new Error('snapshot.css 超过 10 MB 限制');
  if (/@import\b/i.test(css)) throw new Error('snapshot.css 不允许使用 @import');
  if (/<\/style/i.test(css)) throw new Error('snapshot.css 包含非法的 style 闭合标签');
  if (/\b(?:javascript\s*:|expression\s*\(|-moz-binding\b)/i.test(css)) {
    throw new Error('snapshot.css 包含不安全的可执行内容');
  }
  for (const match of css.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim().toLowerCase();
    if (target.startsWith('#') || target.startsWith('data:')) continue;
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
  ).replace(/\sdata-ui-agent-source-rect\s*=\s*(["'])[^"']*\1/gi, '');
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

const PROTECTED_DOM_ATTRIBUTES = new Set(['data-ui-source-id', 'data-ui-agent-source-rect', 'style']);

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
    element.setAttribute('data-ui-source-id', `source-${nextId++}`);
  }
  const rootSourceIds = [...container.children]
    .map(element => element.getAttribute('data-ui-source-id'))
    .filter((value): value is string => Boolean(value));
  return { html: container.innerHTML, rootSourceIds };
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

function compactElementSource(outerHtml: string): string {
  const compactHtml = outerHtml
    .replace(/\sstyle="[^"]*"/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12_000);
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

const LAYOUT_PROPERTIES = [
  'display', 'position', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'overflow', 'overflow-x', 'overflow-y',
  'flex-direction', 'flex-wrap', 'flex-basis', 'flex-grow', 'flex-shrink',
  'align-items', 'align-content', 'justify-content', 'gap', 'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'grid-column', 'grid-row'
] as const;

function sourceLayoutFacts(html: string, css: string, sourceId: string): Record<string, unknown> {
  const range = sourceElementRange(html, sourceId);
  const openingTag = html.slice(range.start, findTagEnd(html, range.start) + 1);
  const rectValues = /\bdata-ui-agent-source-rect\s*=\s*["']([^"']+)["']/i.exec(openingTag)?.[1]
    ?.split(',')
    .map(Number);
  const classNames = /\bclass\s*=\s*["']([^"']+)["']/i.exec(openingTag)?.[1]?.split(/\s+/) ?? [];
  const declarations = new Map<string, string>();
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
  return {
    sourceId,
    tag: range.tag,
    ...(rectValues?.length === 4 && rectValues.every(Number.isFinite) ? {
      capturedRect: {
        x: rectValues[0], y: rectValues[1], width: rectValues[2], height: rectValues[3]
      }
    } : { capturedRect: null }),
    computedLayout: Object.fromEntries(declarations)
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

export class SourceWorkspaceStore {
  private readonly root: string;
  private readonly identityIsolation: boolean;
  private readonly active = new Set<string>();

  constructor(root = '.snapshots/source-workspaces', options: SourceWorkspaceStoreOptions = {}) {
    this.root = resolve(root);
    this.identityIsolation = options.identityIsolation ?? true;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  create(input: unknown, owner: WorkspaceOwner = LOCAL_WORKSPACE_OWNER): SourceWorkspace {
    const snapshot = staticSnapshotSchema.parse(input);
    validateHtml(snapshot.html);
    const compiled = compileSourceWorkspace(snapshot.html, { viewport: snapshot.viewport });
    validateHtml(compiled.html);
    validateCss(compiled.css);
    const workspaceId = randomUUID();
    const directory = this.workspacePath(workspaceId);
    const initialRevision = resolve(directory, 'revisions', '000');
    mkdirSync(initialRevision, { recursive: true, mode: 0o700 });
    const files: WorkspaceFiles = {
      'index.html': compiled.html,
      'snapshot.css': compiled.css,
      'outline.json': compiled.outline,
      'source-map.json': compiled.sourceMap
    };
    this.writeWorkspaceFiles(directory, files);
    this.writeWorkspaceFiles(initialRevision, files);
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
      conversation: []
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
    return {
      protocolVersion: PROTOCOL_VERSION,
      title: manifest.title,
      sourceUrl: manifest.sourceUrl,
      capturedAt: manifest.createdAt,
      html: withStyles,
      nodeCount: Math.max(1, nodeCount),
      selectedSourceId: manifest.selectedSourceId,
      ...(manifest.snapshotMetrics ? { metrics: manifest.snapshotMetrics } : {}),
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

  previewHtml(workspaceId: string): string | undefined {
    if (!this.get(workspaceId)) return undefined;
    const directory = this.workspacePath(workspaceId);
    const html = this.readOptionalFile(resolve(directory, 'index.html'));
    if (!html) return undefined;
    const css = this.readOptionalFile(resolve(directory, 'snapshot.css'));
    if (!css) return html;
    validateHtml(html);
    validateCss(css);
    const style = `<style data-ui-agent-workspace-styles>\n${css}\n</style>`;
    return /<\/head>/i.test(html)
      ? html.replace(/<\/head>/i, `${style}\n</head>`)
      : html.replace(/<body\b/i, `${style}\n<body`);
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

  recordTurn(workspaceId: string, request: SourceTurnRequest, response: SourceTurnResponse): void {
    if (response.kind === 'failed') return;
    const directory = this.workspacePath(workspaceId);
    const manifest = this.readManifest(directory);
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

  tools(workspaceId: string): CodingWorkspaceTools {
    const directory = this.workspacePath(workspaceId);
    if (!this.get(workspaceId)) throw new Error('静态源码工作区不存在');
    if (this.active.has(workspaceId)) throw new Error('当前工作区已有正在执行的修改');
    this.active.add(workspaceId);
    const original = this.readWorkspaceFiles(directory);
    let working: WorkspaceFiles = { ...original };
    const initial = this.readWorkspaceFiles(resolve(directory, 'revisions', '000'));
    const baselineVisibilityIssues = new Set(
      analyzeStaticVisibility(initial['index.html'], initial['snapshot.css']).map(staticVisibilityIssueKey)
    );
    let closed = false;
    const refreshIndexes = () => {
      const indexes = refreshWorkspaceIndexes(working['index.html']);
      working['outline.json'] = indexes.outline;
      working['source-map.json'] = indexes.sourceMap;
    };
    const validateWorking = () => {
      validateHtml(working['index.html']);
      validateCss(working['snapshot.css']);
      const newVisibilityIssues = analyzeStaticVisibility(
        working['index.html'],
        working['snapshot.css']
      ).filter(issue => !baselineVisibilityIssues.has(staticVisibilityIssueKey(issue)));
      if (newVisibilityIssues.length) {
        throw new Error(`静态可见性校验失败：${newVisibilityIssues.slice(0, 3).map(issue => issue.message).join('；')}。请调整父容器尺寸、overflow 或元素定位后重新校验。`);
      }
      return 'HTML、CSS、结构、安全与静态可见性规则校验通过';
    };
    const close = () => {
      if (closed) return;
      closed = true;
      this.active.delete(workspaceId);
    };

    let toolset!: CodingWorkspaceTools;
    toolset = {
      listFiles: async () => WORKSPACE_FILES.map(path => ({ path, chars: working[path].length })),
      searchText: async (query, path = 'index.html') => {
        this.assertReadablePath(path);
        const content = working[path as WorkspaceFile];
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
        this.assertReadablePath(path);
        const content = working[path as WorkspaceFile];
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
      inspectElement: async sourceId => {
        const html = working['index.html'];
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
        const layoutContext = {
          target: sourceLayoutFacts(html, working['snapshot.css'], sourceId),
          ancestors: ancestry
            .slice(0, -1)
            .slice(-6)
            .reverse()
            .map(item => sourceLayoutFacts(html, working['snapshot.css'], item.sourceId)),
          siblings: siblingIds.map(candidate => sourceLayoutFacts(
            html,
            working['snapshot.css'],
            candidate
          ))
        };
        return [
          `元素 ${sourceId}：tag=${range.tag}，字符 ${range.start}-${range.end}`,
          `结构路径: ${ancestry.map(item => `${item.sourceId}<${item.tag}>`).join(' > ')}`,
          `布局上下文: ${JSON.stringify(layoutContext)}`,
          compactElementSource(html.slice(range.start, range.end))
        ].join('\n');
      },
      readStyleRule: async rawClassName => {
        const className = rawClassName.replace(/^\./, '');
        if (!/^[a-zA-Z0-9_-]{1,120}$/.test(className)) {
          throw new Error('样式类名格式无效，请传入 inspect_element 返回的单个 class 名');
        }
        const rules = cssRulesForClass(working['snapshot.css'], className);
        if (rules.length !== 1) {
          throw new Error(rules.length === 0
            ? `snapshot.css 中不存在 .${className} 规则`
            : `snapshot.css 中 .${className} 命中 ${rules.length} 条规则，请改用更具体的样式类`);
        }
        return `snapshot.css 中 .${className} 的完整规则：\n${rules[0]!.slice(0, 16_000)}`;
      },
      replaceText: async (path, search, replacement) => {
        this.assertEditablePath(path);
        const file = path as Extract<WorkspaceFile, 'index.html' | 'snapshot.css'>;
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
        this.assertEditablePath(path);
        if (edits.length < 1 || edits.length > 20) throw new Error('Patch 必须包含 1-20 个编辑操作');
        const file = path as Extract<WorkspaceFile, 'index.html' | 'snapshot.css'>;
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
        working['snapshot.css'] = withoutSourceScopedCss(working['snapshot.css'], removedSourceIds);
        validateCss(working['snapshot.css']);
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
      insertElement: async (targetSourceId, position, fragmentHtml) => {
        const html = working['index.html'];
        const fragment = fragmentWithFreshSourceIds(html, fragmentHtml);
        const targetRange = sourceElementRange(html, targetSourceId);
        let insertionIndex: number;
        if (position === 'parentStart') {
          insertionIndex = findTagEnd(html, targetRange.start) + 1;
        } else if (position === 'parentEnd') {
          insertionIndex = elementClosingTagStart(html, targetRange);
        } else {
          insertionIndex = position === 'before' ? targetRange.start : targetRange.end;
        }
        const next = `${html.slice(0, insertionIndex)}${fragment.html}${html.slice(insertionIndex)}`;
        validateHtml(next);
        working['index.html'] = next;
        refreshIndexes();
        return `已在元素 ${targetSourceId} 的 ${position} 位置插入 ${fragment.rootSourceIds.length} 个顶层元素：${fragment.rootSourceIds.join(', ')}；HTML、结构与安全规则校验通过`;
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
        working['snapshot.css'] = withoutSourceScopedCss(working['snapshot.css'], [sourceId]);
        validateCss(working['snapshot.css']);
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
        working['snapshot.css'] = withoutSourceScopedCss(working['snapshot.css'], removedSourceIds);
        validateCss(working['snapshot.css']);
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
      cloneElement: async (templateSourceId, position, targetSourceId, replacements) => {
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
        const clonedScopedCss = clonedSourceScopedCss(working['snapshot.css'], clone.sourceIdMap);
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
        working['snapshot.css'] = [
          working['snapshot.css'].trimEnd(),
          clonedScopedCss
        ].filter(Boolean).join('\n') + '\n';
        validateCss(working['snapshot.css']);
        refreshIndexes();
        return `已从模板 ${templateSourceId} 完整克隆元素 ${clone.rootSourceId}${destination}；结构、冻结样式和伪元素样式已同步；HTML、CSS 与安全规则校验通过`;
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
      commit: async summary => {
        if (working['index.html'] === original['index.html'] && working['snapshot.css'] === original['snapshot.css']) {
          throw new Error('Agent 没有对静态源码产生修改');
        }
        validateWorking();
        const revision = this.commitWorkingCopy(workspaceId, working, summary);
        close();
        return revision;
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

  private assertEditablePath(path: string) {
    if (path !== 'index.html' && path !== 'snapshot.css') {
      throw new Error(`源码 Agent 只能修改 index.html 或 snapshot.css，拒绝路径 ${path}`);
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
      'outline.json': this.readOptionalFile(resolve(directory, 'outline.json')) ?? generated.outline,
      'source-map.json': this.readOptionalFile(resolve(directory, 'source-map.json')) ?? generated.sourceMap
    };
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
    JSON.parse(files['outline.json']);
    JSON.parse(files['source-map.json']);
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

  private atomicWrite(path: string, content: string) {
    const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  }
}
