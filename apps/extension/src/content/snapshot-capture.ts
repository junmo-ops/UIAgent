import { PROTOCOL_VERSION, staticSnapshotSchema, type SnapshotMetrics, type StaticSnapshot } from '@ui-agent/contracts';
import { captureAccessibleAuthorStyles } from './author-style-capture';
import type { AuthorStyleResource } from '@ui-agent/contracts';

const SNAPSHOT_OPTIMIZATION_VERSION = 'style-dedup-v1';

const OMITTED_STYLE_PROPERTIES = new Set([
  // 普通元素的 content 不影响渲染；伪元素在 capturePseudoStyle 中单独处理。
  'content',
  // 这两个历史属性可能引入非标准行为，不属于静态页面的视觉还原范围。
  'behavior',
  '-moz-binding'
]);
const MAX_STYLE_VALUE_LENGTH = 4_096;

const BLOCKED_TAGS = new Set([
  'SCRIPT', 'NOSCRIPT', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'BASE',
  'STYLE', 'LINK', 'META', 'TEMPLATE'
]);
const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'xlink:href']);
const CONTROLLED_INTERACTION_ATTRIBUTES = new Set([
  'data-ui-agent-action', 'data-ui-agent-targets', 'data-ui-agent-state-group',
  'data-ui-agent-state-value', 'data-ui-agent-state-when', 'data-ui-agent-active-class',
  'data-ui-agent-state-active'
]);

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function isSafeInlineUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  // Fragment references are how inline SVG `<use>` nodes address their local
  // symbol definitions. They never initiate a network request or script.
  return normalized.startsWith('#') || normalized.startsWith('data:image/') || normalized.startsWith('data:font/');
}

function normalizeComputedStyleValue(property: string, value: string): string {
  if (property !== 'font-family') return value;
  // 部分业务站点会把整段字体栈误写成一个带引号的字体名，例如
  // "PingFang SC,Microsoft YaHei,Arial,sans-serif"。同机运行时会静默回退，
  // 但跨系统导入后回退字体不同，文字度量会变化并引发换行。快照里还原为字体栈。
  const quotedStack = value.match(/^(["'])(.+,.+)\1$/);
  return quotedStack ? quotedStack[2]!.trim() : value;
}

function computedPropertyNames(computed: CSSStyleDeclaration, overrides: Readonly<Record<string, string>>): string[] {
  const properties = new Set<string>();
  for (let index = 0; index < computed.length; index += 1) {
    const property = computed.item(index).trim();
    if (property) properties.add(property);
  }
  for (const property of Object.keys(overrides)) properties.add(property);
  return [...properties];
}

function isCapturableStyle(property: string, value: string): boolean {
  if (!property || property.startsWith('--') || OMITTED_STYLE_PROPERTIES.has(property)) return false;
  if (!value || value.length > MAX_STYLE_VALUE_LENGTH) return false;
  // 不把外部背景、光标、滤镜等资源写进静态副本；纯色、渐变等无资源值会保留。
  return !/url\s*\(/i.test(value);
}

function preserveSafeInlineStyle(element: HTMLElement): void {
  for (const property of [...element.style]) {
    const value = element.style.getPropertyValue(property);
    if (/\b(?:javascript\s*:|expression\s*\(|-moz-binding\b|behavior\s*:)/i.test(value)) {
      element.style.removeProperty(property);
      continue;
    }
    // External resources remain out of the frozen A package. B obtains its
    // declared resources from the preserved author stylesheet instead.
    if (/url\s*\(/i.test(value)) element.style.removeProperty(property);
  }
  if (!element.getAttribute('style')?.trim()) element.removeAttribute('style');
}

function copyLiveState(source: Element, clone: Element): void {
  if (source instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
    clone.value = source.value;
    clone.setAttribute('value', source.value);
    clone.checked = source.checked;
    if (source.checked) clone.setAttribute('checked', '');
    else clone.removeAttribute('checked');
  } else if (source instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) {
    clone.value = source.value;
    clone.textContent = source.value;
  } else if (source instanceof HTMLOptionElement && clone instanceof HTMLOptionElement) {
    clone.selected = source.selected;
    if (source.selected) clone.setAttribute('selected', '');
    else clone.removeAttribute('selected');
  } else if (source instanceof HTMLDetailsElement && clone instanceof HTMLDetailsElement) {
    clone.open = source.open;
  }
}

function computedStyleDeclarations(
  computed: CSSStyleDeclaration,
  overrides: Readonly<Record<string, string>> = {}
): string[] {
  const declarations: string[] = [];
  for (const property of computedPropertyNames(computed, overrides)) {
    const value = (overrides[property] ?? computed.getPropertyValue(property)).trim();
    if (!isCapturableStyle(property, value)) continue;
    declarations.push(`${property}:${normalizeComputedStyleValue(property, value)}`);
  }
  return declarations;
}

function preservesSingleRenderedLine(source: Element, computed: CSSStyleDeclaration): boolean {
  if (!source.textContent?.trim()) return false;
  const whiteSpace = computed.getPropertyValue('white-space').trim();
  if (whiteSpace && whiteSpace !== 'normal' && whiteSpace !== 'pre-line') return false;
  const rect = source.getBoundingClientRect();
  const fontSize = Number.parseFloat(computed.getPropertyValue('font-size'));
  const lineHeightValue = computed.getPropertyValue('line-height').trim();
  const lineHeight = Number.parseFloat(lineHeightValue);
  const estimatedLineHeight = Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.5;
  return rect.height > 0
    && Number.isFinite(estimatedLineHeight)
    && rect.height <= estimatedLineHeight * 1.25;
}

interface StyleRegistry {
  rules: Map<string, string>;
  inlineStyleCharsBefore: number;
}

function applyComputedStyle(source: Element, clone: Element, registry: StyleRegistry): void {
  const computed = getComputedStyle(source);
  const declarations = computedStyleDeclarations(
    computed,
    preservesSingleRenderedLine(source, computed) ? { 'white-space': 'nowrap' } : {}
  );
  const declaration = declarations.join(';');
  if (!declaration) {
    clone.removeAttribute('style');
    return;
  }
  const className = registry.rules.get(declaration) ?? `ui-snapshot-style-${registry.rules.size}`;
  registry.rules.set(declaration, className);
  registry.inlineStyleCharsBefore += declaration.length + 8;
  clone.classList.add(className);
  if (clone instanceof HTMLElement) preserveSafeInlineStyle(clone);
}

function captureImageResource(source: Element, clone: Element, resources: AuthorStyleResource[]): void {
  if (!(source instanceof HTMLImageElement)) return;
  const src = source.currentSrc || source.src;
  if (!src) return;
  try {
    const url = new URL(src);
    if (!/^https?:$/i.test(url.protocol)) return;
    resources.push({ url: url.toString(), sourceUrl: location.href, kind: 'image' });
    // The actual URL deliberately stays out of static HTML. The service turns
    // this opaque value into a same-origin asset URL for preview rendering.
    clone.setAttribute('data-ui-agent-resource-url', encodeURIComponent(url.toString()));
  } catch {
    // A malformed visual resource should not prevent capturing the page.
  }
}

function capturePseudoStyle(source: Element, sourceId: string, pseudo: '::before' | '::after'): string | undefined {
  const computed = getComputedStyle(source, pseudo);
  const content = computed.getPropertyValue('content').trim();
  if (
    !content || content === 'none' || content === 'normal'
    || /url\s*\(/i.test(content) || /[<>]/.test(content)
  ) return undefined;
  const declarations = [`content:${content}`, ...computedStyleDeclarations(computed)];
  return `[data-ui-source-id="${sourceId}"]${pseudo}{${declarations.join(';')}}`;
}

function sanitizeElement(source: Element, clone: Element, registry: StyleRegistry, resources: AuthorStyleResource[]): void {
  copyLiveState(source, clone);
  applyComputedStyle(source, clone, registry);
  captureImageResource(source, clone, resources);

  for (const attribute of [...clone.attributes]) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim();
    if (CONTROLLED_INTERACTION_ATTRIBUTES.has(name)) {
      clone.removeAttribute(attribute.name);
      continue;
    }
    if (name.startsWith('on') || name === 'srcdoc' || name === 'http-equiv') {
      clone.removeAttribute(attribute.name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name) && !isSafeInlineUrl(value)) {
      if (name === 'href' && /^https?:/i.test(value)) clone.setAttribute('data-snapshot-href', value.slice(0, 500));
      clone.removeAttribute(attribute.name);
    }
  }

  if (clone instanceof HTMLButtonElement) clone.type = 'button';
  if (clone instanceof HTMLFormElement) {
    clone.removeAttribute('action');
    clone.removeAttribute('method');
    clone.setAttribute('data-snapshot-form', 'disabled');
  }
}

function capturedRect(source: Element): string {
  const rect = source.getBoundingClientRect();
  return [rect.x, rect.y, rect.width, rect.height]
    .map(value => Math.round(value * 100) / 100)
    .join(',');
}

function sanitizeTree(sourceRoot: HTMLElement, cloneRoot: HTMLElement, registry: StyleRegistry, resources: AuthorStyleResource[]): string[] {
  const sourceElements = [sourceRoot, ...sourceRoot.querySelectorAll('*')];
  const cloneElements = [cloneRoot, ...cloneRoot.querySelectorAll('*')];
  const pseudoRules: string[] = [];

  for (let index = cloneElements.length - 1; index >= 0; index -= 1) {
    const source = sourceElements[index];
    const clone = cloneElements[index];
    if (!source || !clone) continue;
    if (BLOCKED_TAGS.has(clone.tagName) || clone.hasAttribute('data-ui-agent-overlay')) {
      clone.remove();
      continue;
    }
    const sourceId = `source-${index}`;
    clone.setAttribute('data-ui-source-id', sourceId);
    clone.setAttribute('data-ui-agent-source-rect', capturedRect(source));
    sanitizeElement(source, clone, registry, resources);
    for (const pseudo of ['::before', '::after'] as const) {
      const rule = capturePseudoStyle(source, sourceId, pseudo);
      if (rule) pseudoRules.push(rule);
    }
  }

  const removeComments = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) child.parentNode?.removeChild(child);
      else removeComments(child);
    }
  };
  removeComments(cloneRoot);
  return pseudoRules;
}

function removeSerializationArtifacts(root: HTMLElement): void {
  // 部分页面会在 <p> 内嵌入块级元素。浏览器实际 DOM 能正常展示，但将 HTML
  // 跨文档序列化、再解析时会补出无属性的空 <p>。它们不属于采集到的源节点，
  // 却会带上浏览器默认 margin，造成副本中凭空出现纵向留白。
  for (const element of [...root.querySelectorAll('p')]) {
    if (
      !element.hasAttribute('data-ui-source-id')
      && element.attributes.length === 0
      && element.children.length === 0
      && !element.textContent?.trim()
    ) {
      element.remove();
    }
  }
}

/**
 * Framework-created DOM may contain a list item inside another list item.
 * Browsers retain that live tree, but HTML parsing closes the outer `li`
 * before the inner one when a snapshot is reopened. Collapse content-free
 * wrappers so the snapshot survives HTML serialization without gaining an
 * extra flex/list item.
 */
function normalizeNestedListItems(root: HTMLElement): void {
  for (const outer of [...root.querySelectorAll('li')].reverse()) {
    const children = [...outer.children];
    const innerItems = children.filter(child => child.tagName === 'LI');
    const hasOnlyWhitespaceBesidesInner = [...outer.childNodes].every(node =>
      node === innerItems[0]
      || node.nodeType === Node.COMMENT_NODE
      || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
    );
    if (innerItems.length !== 1 || children.length !== 1 || !hasOnlyWhitespaceBesidesInner) continue;
    const inner = innerItems[0]!;
    for (const attribute of [...outer.attributes]) {
      if (attribute.name === 'class') {
        inner.classList.add(...attribute.value.split(/\s+/).filter(Boolean));
        continue;
      }
      if (attribute.name === 'data-ui-source-id' || attribute.name === 'data-ui-agent-source-rect') continue;
      if (!inner.hasAttribute(attribute.name)) inner.setAttribute(attribute.name, attribute.value);
    }
    outer.replaceWith(inner);
  }
}

function bodyContextAttributes(sourceBody: HTMLElement): string {
  const contextAttributes = ['class', 'dir', 'lang', 'data-theme']
    .flatMap(name => {
      const value = sourceBody.getAttribute(name);
      return value === null ? [] : [`${name}="${escapeHtml(value)}"`];
    });
  return contextAttributes.length ? ` ${contextAttributes.join(' ')}` : '';
}

export function captureStaticSnapshot(sourceRoot: HTMLElement): StaticSnapshot {
  const authorStyles = captureAccessibleAuthorStyles(document);
  const authorStyleSources = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))
    .map(link => link.href)
    .filter((value, index, values) => values.indexOf(value) === index);
  const cloneRoot = sourceRoot.cloneNode(true) as HTMLElement;
  const registry: StyleRegistry = { rules: new Map(), inlineStyleCharsBefore: 0 };
  const visualResources: AuthorStyleResource[] = [];
  const pseudoRules = sanitizeTree(sourceRoot, cloneRoot, registry, visualResources);
  normalizeNestedListItems(cloneRoot);
  authorStyles.resources = [...new Map(
    [...(authorStyles.resources ?? []), ...visualResources].map(resource => [resource.url, resource])
  ).values()];
  let renderedRoot = cloneRoot;
  if (sourceRoot === document.body) {
    renderedRoot = document.createElement('div');
    for (const attribute of [...cloneRoot.attributes]) {
      renderedRoot.setAttribute(attribute.name, attribute.value);
    }
    renderedRoot.innerHTML = cloneRoot.innerHTML;
    removeSerializationArtifacts(renderedRoot);
  }
  const nodeCount = 1 + renderedRoot.querySelectorAll('*').length;
  const viewportWidth = Math.max(1, Math.round(innerWidth));
  const viewportHeight = Math.max(1, Math.round(innerHeight));
  const pageBackground = getComputedStyle(document.body).backgroundColor || '#ffffff';
  const title = `${document.title || '未命名页面'} · 静态快照`;

  renderedRoot.setAttribute('data-ui-agent-snapshot-root', '');
  if (renderedRoot.style.position === 'fixed' || renderedRoot.style.position === 'absolute') {
    renderedRoot.style.position = 'relative';
  }
  renderedRoot.style.margin = '0';

  const capturedStyles = [...registry.rules.entries()]
    .map(([declaration, className]) => `.${className}{${declaration}}`)
    .join('\n    ');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    html,body{margin:0;width:100%;min-width:${viewportWidth}px;min-height:${viewportHeight}px;box-sizing:border-box}
    *,*::before,*::after{box-sizing:border-box}
    body{padding:0;background:${pageBackground};overflow:auto}
    [data-ui-agent-snapshot-stage]{display:block;width:${viewportWidth}px;min-width:${viewportWidth}px;min-height:${viewportHeight}px;margin:0 auto;transform:translateZ(0)}
    ${capturedStyles}
    ${pseudoRules.join('\n    ')}
  </style>
</head>
<body data-ui-agent-static-snapshot="true"${sourceRoot === document.body ? bodyContextAttributes(sourceRoot) : ''}>
  <main data-ui-agent-snapshot-stage>${renderedRoot.outerHTML}</main>
</body>
</html>`;

  const rawDomChars = renderedRoot.outerHTML.length;
  const uniqueStyleChars = [...registry.rules.keys()].reduce((total, declaration) => total + declaration.length, 0);
  const pseudoStyleChars = pseudoRules.reduce((total, rule) => total + rule.length, 0);
  const styleDedupSavedChars = Math.max(0, registry.inlineStyleCharsBefore - uniqueStyleChars);
  const inlineDataResourceChars = [...html.matchAll(/data:(?:image|font)\/[^"'\s)]+/gi)]
    .reduce((total, match) => total + match[0].length, 0);
  const metrics: SnapshotMetrics = {
    optimizationVersion: SNAPSHOT_OPTIMIZATION_VERSION,
    rawDomChars,
    inlineStyleCharsBefore: registry.inlineStyleCharsBefore,
    uniqueStyleRuleCount: registry.rules.size,
    uniqueStyleChars,
    styleDedupSavedChars,
    pseudoStyleChars,
    inlineDataResourceChars,
    serializedHtmlCharsBefore: html.length + styleDedupSavedChars,
    serializedHtmlCharsAfter: html.length,
    authorReadableSheets: authorStyles.readableSheets,
    authorUnreadableSheets: authorStyles.unreadableSheets,
    authorMissingSources: authorStyles.missing
  };
  return staticSnapshotSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    title,
    sourceUrl: location.href,
    capturedAt: new Date().toISOString(),
    html,
    nodeCount,
    selectedSourceId: 'source-0',
    metrics,
    authorStyles: authorStyles.cssText || authorStyles.resources.length || authorStyles.unreadableSources?.length ? authorStyles : undefined,
    authorStyleSources,
    viewport: {
      width: viewportWidth,
      height: viewportHeight
    }
  });
}
