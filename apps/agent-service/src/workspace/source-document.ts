import { type CapturedLayoutIndex, type StructureNode } from './workspace-types';
import { parseHTML } from 'linkedom';
import { CAPTURED_LAYOUT_PROPERTIES } from '@ui-agent/contracts';

export function structureQueryTerms(query: string): string[] {
  return [...new Set(
    query
      .toLocaleLowerCase()
      .split(/[\s,，。；;、|/\\()[\]{}"'“”‘’]+/)
      .map(part => part.trim())
      .filter(part => part.length >= 2)
  )].slice(0, 12);
}

export function normalizeStructureSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\u00a0]+/g, '');
}

export function structureNeighborhood(nodes: StructureNode[], sourceId: string): Record<string, unknown> {
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

export function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(search, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(1, search.length);
  }
}

export const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findTagEnd(content: string, start: number): number {
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

export function sourceElementRange(content: string, sourceId: string): { start: number; end: number; tag: string } {
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

export interface SourceElementAncestor {
  sourceId: string;
  tag: string;
}

export function sourceElementAncestry(content: string, sourceId: string): SourceElementAncestor[] {
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

export function elementClosingTagStart(
  content: string,
  range: { start: number; end: number; tag: string }
): number {
  const outerHtml = content.slice(range.start, range.end);
  const closing = new RegExp(`<\\/\\s*${escapeRegExp(range.tag)}\\s*>\\s*$`, 'i').exec(outerHtml);
  if (!closing || closing.index === undefined) throw new Error(`元素缺少 </${range.tag}> 闭合标签`);
  return range.start + closing.index;
}

export function cloneWithFreshSourceIds(
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

export function clonedSourceScopedCss(css: string, sourceIdMap: ReadonlyMap<string, string>): string {
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

export function sourceElementInnerRange(
  content: string,
  range: { start: number; end: number; tag: string }
): { start: number; end: number } {
  if (VOID_HTML_TAGS.has(range.tag)) throw new Error(`<${range.tag}> 是空元素，没有可编辑的内部内容`);
  return {
    start: findTagEnd(content, range.start) + 1,
    end: elementClosingTagStart(content, range)
  };
}

export function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', '&quot;');
}

export const PROTECTED_DOM_ATTRIBUTES = new Set(['data-ui-source-id', 'data-ui-agent-source-rect', 'data-ui-agent-captured-layout', 'style']);

export function assertMutableAttributeName(name: string): void {
  const normalized = name.toLowerCase();
  if (!/^[a-z_:][a-z0-9_.:-]*$/i.test(name)) throw new Error(`属性名 ${name} 无效`);
  if (PROTECTED_DOM_ATTRIBUTES.has(normalized)) {
    throw new Error(`属性 ${name} 由工作区维护，不能通过结构化属性工具修改`);
  }
}

export function updateOpeningTagAttributes(
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

export function nextSourceNumber(content: string): number {
  return Math.max(
    -1,
    ...[...content.matchAll(/\bdata-ui-source-id\s*=\s*["']source-(\d+)["']/gi)]
      .map(match => Number(match[1]))
      .filter(Number.isFinite)
  ) + 1;
}

export function fragmentWithFreshSourceIds(
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

export function applyFrozenReferenceStyles(
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

export function wrapperOpeningTag(tagName: string, sourceId: string, attributes: Readonly<Record<string, string>>): string {
  if (!/^[a-z][a-z0-9-]*$/i.test(tagName) || VOID_HTML_TAGS.has(tagName.toLowerCase())) {
    throw new Error(`包装标签 ${tagName} 无效或不能包含子节点`);
  }
  const renderedAttributes = Object.entries(attributes).map(([name, value]) => {
    assertMutableAttributeName(name);
    return `${name}="${escapeHtmlAttribute(value)}"`;
  });
  return `<${tagName} data-ui-source-id="${sourceId}"${renderedAttributes.length ? ` ${renderedAttributes.join(' ')}` : ''}>`;
}

export function withoutSourceScopedCss(css: string, sourceIds: readonly string[]): string {
  let next = css;
  for (const sourceId of sourceIds) {
    const selector = `\\[data-ui-source-id\\s*=\\s*(["'])${escapeRegExp(sourceId)}\\1\\]`;
    next = next.replace(new RegExp(`${selector}(?:::(?:before|after))?\\s*\\{[^}]*\\}\\s*`, 'gi'), '');
  }
  return next;
}

export function decodeBasicEntities(value: string): string {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

export function compactElementSource(outerHtml: string, maxHtmlChars = 4_000): string {
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
    'visibilityNote: domText 仅表示源码中存在文字，不代表元素在渲染后可见；完成时的内置工作区校验会检查静态裁剪风险。',
    `rawTextSegments: ${JSON.stringify(rawTextSegments)}`,
    'sourceNote: compactHtml 是删除 style、折叠空白且可能截断的结构摘要，不能用作精确替换原文；rawTextSegments 仅是去除首尾空白的文本片段。纯文字修改优先按实际文字元素 sourceId 使用 set_element_text；需要 HTML 精确替换时先读取完整原始源码。',
    `styleClasses: ${JSON.stringify(styleClasses)}`,
    `compactHtml: ${compactHtml}`
  ].join('\n');
}

export const LAYOUT_PROPERTIES = CAPTURED_LAYOUT_PROPERTIES;

export const COMPACT_TARGET_LAYOUT_PROPERTIES = new Set([
  'display', 'position', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'overflow', 'overflow-x', 'overflow-y', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink',
  'align-items', 'justify-content', 'gap', 'grid-template-columns', 'grid-auto-flow'
]);

export const COMPACT_CONTEXT_LAYOUT_PROPERTIES = new Set([
  'display', 'position', 'width', 'height', 'overflow', 'flex-direction', 'flex-wrap',
  'align-items', 'justify-content', 'gap', 'grid-template-columns'
]);

export function extractCapturedLayoutIndex(html: string): { html: string; layoutIndex: CapturedLayoutIndex } {
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

export function sourceLayoutFacts(
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

export function cssRulesForClasses(
  content: string,
  classNames: readonly string[],
  limitPerClass = Number.POSITIVE_INFINITY
): Map<string, string[]> {
  const names = [...new Set(classNames.filter(Boolean))];
  const matches = new Map(names.map(name => [name, [] as string[]]));
  if (!names.length) return matches;
  const tokens = names.map(name => ({
    name, pattern: new RegExp('\\.' + escapeRegExp(name) + '(?![\\w-]|\\\\)')
  }));
  const blocks: Array<{ opening: number; prelude: string }> = [];
  let statementStart = 0;
  let quote: '"' | "'" | undefined;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (char === '\\') { index += 1; continue; }
    if (quote) {
      if (char === quote || char === '\n' || char === '\r') quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '/' && content[index + 1] === '*') {
      const end = content.indexOf('*/', index + 2);
      if (end < 0) break;
      if (!content.slice(statementStart, index).trim()) statementStart = end + 2;
      index = end + 1;
      continue;
    }
    if (char === '(') { parentheses += 1; continue; }
    if (char === ')') { parentheses = Math.max(0, parentheses - 1); continue; }
    if (char === '[') { brackets += 1; continue; }
    if (char === ']') { brackets = Math.max(0, brackets - 1); continue; }
    if (parentheses || brackets) continue;
    if (char === '{') {
      blocks.push({ opening: index, prelude: content.slice(statementStart, index).trim() });
      statementStart = index + 1;
    } else if (char === ';') {
      statementStart = index + 1;
    } else if (char === '}') {
      const block = blocks.pop();
      if (block && block.prelude && !block.prelude.startsWith('@')) {
        // Class-looking text in comments, strings and attribute values is not a class selector.
        const selectorTokens = block.prelude.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[(?:\\.|[^\]\\])*\]/g, '');
        const matched = tokens.filter(token => (
          matches.get(token.name)!.length < limitPerClass && token.pattern.test(selectorTokens)
        ));
        if (matched.length) {
          // Preserve conditions, cascade layers and nesting parents.
          const rule = blocks.map(parent => parent.prelude + '{').join('')
            + block.prelude + content.slice(block.opening, index + 1)
            + '}'.repeat(blocks.length);
          for (const token of matched) matches.get(token.name)!.push(rule);
        }
      }
      statementStart = index + 1;
    }
  }
  return matches;
}

export function cssRulesForClass(content: string, className: string): string[] {
  return cssRulesForClasses(content, [className]).get(className) ?? [];
}

export function boundedStyleEntries(entries: readonly string[], budget: number): string {
  const kept: string[] = [];
  let size = 0;
  let omitted = 0;
  for (const entry of entries) {
    if (size + entry.length + 1 > budget - 160) { omitted += 1; continue; }
    kept.push(entry);
    size += entry.length + 1;
  }
  if (omitted) kept.push(
    '[省略 ' + omitted + ' 条：超出输出预算，未截断规则；可缩小查询范围或读取对应样式文件]'
  );
  return kept.join('\n');
}

export function elementClassNames(openingTag: string): string[] {
  return [...new Set(
    (/\bclass\s*=\s*["']([^"']+)["']/i.exec(openingTag)?.[1] ?? '')
      .split(/\s+/)
      .filter(Boolean)
  )];
}

export function antDesignComponentGuidance(tag: string, classNames: readonly string[]): string | undefined {
  const standardEvidence = classNames.some(className => className === 'anticon' || className.startsWith('ant-'));
  const componentFamilies = ['btn', 'checkbox', 'radio', 'input', 'select'] as const;
  const compatibleFamilies = componentFamilies.flatMap(family => classNames
    .map(className => new RegExp(`^(.*)-${family}$`).exec(className)?.[1])
    .filter((prefix): prefix is string => Boolean(prefix))
    .filter(prefix => classNames.some(className => className.startsWith(`${prefix}-${family}-`)))
    .map(prefix => ({ prefix, family })));
  const compatibleEvidence = compatibleFamilies.length > 0;
  if (!standardEvidence && !compatibleEvidence) return undefined;

  const evidence = standardEvidence
    ? classNames.filter(className => className === 'anticon' || className.startsWith('ant-')).slice(0, 6)
    : classNames.filter(className => compatibleFamilies.some(({ prefix, family }) => (
        className.startsWith(`${prefix}-${family}`)
      ))).slice(0, 6);
  const versionNote = '以下原站线索仅供保留既有实现的小改或原样复制参考；新增、重做、改变控件类型或组合交互必须使用 ui-agent-module 中真正的 Ant Design 组件。风格一致要求不改变该实现选择。原页面版本未知。';
  if (tag === 'button' || classNames.some(className => /(?:^|-)btn(?:-|$)/.test(className))) {
    const iconOnly = classNames.some(className => /(?:^|-)btn-icon-only$/.test(className));
    const baseClasses = classNames.filter(className => /(?:^|-)btn(?:$|-(?:default|primary|dashed|link|text))$/.test(className));
    return [
      `组件库线索: Ant Design${compatibleEvidence && !standardEvidence ? ' 兼容前缀' : ''}；证据 class=${JSON.stringify(evidence)}；${versionNote}`,
      `组件类型: Button${iconOnly ? '（当前为 icon-only 形态）' : ''}。`,
      `既有按钮小改规范（不适用于重做或组合交互）: 保留页面现有基础/类型 class${baseClasses.length ? ` ${JSON.stringify(baseClasses)}` : ''} 和主题；图标按钮改为文字按钮时通常移除 icon-only、固定正方形尺寸及零 padding 约束。除非用户明确要求，不自行切换 primary/default 类型；只检查当前元素实际命中的覆盖规则。`
    ].join('\n');
  }
  if (classNames.some(className => /(?:^|-)checkbox(?:-|$)/.test(className))) {
    return `组件库线索: Ant Design；证据 class=${JSON.stringify(evidence)}；${versionNote}\n组件类型: Checkbox。仅调整外观时保留既有结构；新增或重做勾选使用 module.jsx 中的 antd.Checkbox，不能把静态复制视为功能恢复。原生勾选由浏览器处理，静态 wrapper/inner 的状态 class 不会因缺失的 React 自动同步；可用 :checked 等 CSS 表达视觉状态，不要重复绑定事件拦截原生勾选。样式参考当前主题。`;
  }
  if (classNames.some(className => /(?:^|-)radio(?:-|$)/.test(className))) {
    return `组件库线索: Ant Design；证据 class=${JSON.stringify(evidence)}；${versionNote}\n组件类型: Radio。仅调整外观时保留既有结构；新增或重做单选使用 module.jsx 中的 antd.Radio/Radio.Group，不能把静态复制视为功能恢复。原生互斥选择由浏览器处理，视觉状态可用 :checked 表达，不依赖原站 React 更新 class，不重复绑定事件拦截原生选择。组内布局以实际容器和用户要求为准。`;
  }
  if (tag === 'input' || classNames.some(className => /(?:^|-)input(?:-|$)/.test(className))) {
    return `组件库线索: Ant Design；证据 class=${JSON.stringify(evidence)}；${versionNote}\n组件类型: Input。既有控件修改规范: 保留页面现有 input、affix-wrapper、size 和状态 class；placeholder 用属性修改，尺寸和前后缀结构以实际 DOM 为准。`;
  }
  if (classNames.some(className => /(?:^|-)select(?:-|$)/.test(className))) {
    return `组件库线索: Ant Design；证据 class=${JSON.stringify(evidence)}；${versionNote}\n组件类型: Select。仅调整既有控件外观时保留结构；新增或重做下拉及组合交互使用 ui-agent-module 中的 antd.Select，不用原生 select 或手写浮层替代；明确原样复制时保留原结构。采用 ui-agent-module 时，在 module.jsx 中直接组合平台提供的 React 与 Ant Design 组件，并根据实际布局设置宿主位置；不要复制 selector、selection item、arrow 的内部 DOM，也不要修改 React 管理的 DOM 或 Ant Design 内部 class。真实业务联动应先 clarify。`;
  }
  return `组件库线索: Ant Design；证据 class=${JSON.stringify(evidence)}；${versionNote}`;
}

export function relevantElementStyleContext(
  tag: string,
  openingTag: string,
  sources: ReadonlyArray<{ path: string; content: string }>
): string | undefined {
  const classNames = elementClassNames(openingTag).slice(0, 24);
  if (!classNames.length) return undefined;
  const perClass = new Map<string, string[]>();
  // Reserve the output budget for editable overrides before original rules.
  for (const source of [...sources].sort((a, b) => Number(b.path === 'author-overrides.css') - Number(a.path === 'author-overrides.css'))) {
    const sourceMatches = cssRulesForClasses(source.content, classNames, 2);
    for (const [className, rules] of sourceMatches) {
      if (!rules.length) continue;
      const values = perClass.get(className) ?? [];
      values.push(...rules.map(rule => `${source.path}: ${rule}`));
      perClass.set(className, values);
    }
  }
  const rules = [...perClass]
    .flatMap(([className, values]) => values.map(value => `.${className} -> ${value}`))
    .sort((a, b) => Number(b.includes('-> author-overrides.css:')) - Number(a.includes('-> author-overrides.css:')));
  const componentGuidance = antDesignComponentGuidance(tag, classNames);
  if (!rules.length && !componentGuidance) return undefined;
  const boundedRules = boundedStyleEntries(rules, 4_000);
  return [componentGuidance, rules.length ? `目标 class 的候选规则（覆盖层优先展示；条件与完整选择器仍需核对，不代表当前渲染已生效）:\n${boundedRules}` : undefined]
    .filter(Boolean)
    .join('\n');
}

export function cssSnippetsForSymbol(content: string, symbol: string, limit = 6): string[] {
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
