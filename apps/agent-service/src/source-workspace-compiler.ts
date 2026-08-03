import { parseHTML } from 'linkedom';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);

export interface WorkspaceOutlineNode {
  sourceId: string;
  tag: string;
  role?: string;
  text: string;
  depth: number;
  parentSourceId?: string;
  childrenSourceIds: string[];
  classes: string[];
}

export interface WorkspaceSourceMapEntry {
  sourceId: string;
  file: 'index.html';
  line: number;
  selector: string;
  styleClasses: string[];
  ancestry: string[];
}

export interface CompiledSourceWorkspace {
  html: string;
  css: string;
  outline: string;
  sourceMap: string;
}

function compactText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function elementSummaryText(element: Element): string {
  const directText = [...element.childNodes]
    .filter(node => node.nodeType === 3)
    .map(node => node.textContent)
    .join(' ');
  return compactText(
    directText
    || element.getAttribute('aria-label')
    || element.getAttribute('placeholder')
    || element.getAttribute('title')
    || element.getAttribute('value')
  );
}

function prettyHtml(html: string): string {
  const lines = html
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  let depth = 0;
  return lines.map(line => {
    const closing = /^<\s*\//.test(line);
    const rendered = `${'  '.repeat(Math.max(0, depth - (closing ? 1 : 0)))}${line}`;
    const openingTags = [...line.matchAll(/<\s*([a-z][\w:-]*)\b[^>]*>/gi)]
      .filter(match => !/^<\s*\//.test(match[0]) && !/\/\s*>$/.test(match[0]))
      .map(match => match[1]!.toLowerCase())
      .filter(tag => !VOID_TAGS.has(tag)).length;
    const closingTags = [...line.matchAll(/<\s*\/\s*([a-z][\w:-]*)\s*>/gi)].length;
    depth = Math.max(0, depth + openingTags - closingTags);
    return rendered;
  }).join('\n');
}

function sourceLineMap(html: string): Map<string, number> {
  const result = new Map<string, number>();
  html.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\bdata-ui-source-id\s*=\s*["']([^"']+)["']/gi)) {
      result.set(match[1]!, index + 1);
    }
  });
  return result;
}

export function compileSourceWorkspace(inputHtml: string): CompiledSourceWorkspace {
  const { document } = parseHTML(inputHtml);
  const baselineCss = [...document.querySelectorAll('style')]
    .map(element => element.textContent?.trim())
    .filter(Boolean);
  for (const element of [...document.querySelectorAll('style')]) element.remove();

  const styles = new Map<string, string>();
  for (const element of [...document.querySelectorAll('[style]')]) {
    const declaration = element.getAttribute('style')?.trim();
    if (!declaration) {
      element.removeAttribute('style');
      continue;
    }
    let className = styles.get(declaration);
    if (!className) {
      className = `ui-snapshot-style-${styles.size}`;
      styles.set(declaration, className);
    }
    element.classList.add(className);
    element.removeAttribute('style');
  }

  const html = prettyHtml(document.toString());
  const css = [
    '/* UI Agent Workspace V2: frozen snapshot styles */',
    ...baselineCss,
    ...[...styles.entries()].map(([declaration, className]) => `.${className}{${declaration}}`)
  ].filter(Boolean).join('\n\n') + '\n';

  const sourceElements = [...document.querySelectorAll('[data-ui-source-id]')];
  const nodes: WorkspaceOutlineNode[] = sourceElements.map(element => {
    const sourceId = element.getAttribute('data-ui-source-id')!;
    const parent = element.parentElement?.closest('[data-ui-source-id]');
    const children = [...element.children]
      .flatMap(child => {
        if (child.hasAttribute('data-ui-source-id')) return [child];
        return [...child.querySelectorAll('[data-ui-source-id]')]
          .filter(candidate => candidate.parentElement?.closest('[data-ui-source-id]') === element);
      });
    let depth = 0;
    let ancestor = parent;
    while (ancestor) {
      depth += 1;
      ancestor = ancestor.parentElement?.closest('[data-ui-source-id]') ?? null;
    }
    return {
      sourceId,
      tag: element.localName.toLowerCase(),
      ...(element.getAttribute('role') ? { role: element.getAttribute('role')! } : {}),
      text: elementSummaryText(element),
      depth,
      ...(parent?.getAttribute('data-ui-source-id')
        ? { parentSourceId: parent.getAttribute('data-ui-source-id')! }
        : {}),
      childrenSourceIds: children
        .map(child => child.getAttribute('data-ui-source-id'))
        .filter((value): value is string => Boolean(value)),
      classes: [...element.classList].filter(className => !className.startsWith('ui-snapshot-style-'))
    };
  });

  const lines = sourceLineMap(html);
  const sourceMapEntries: WorkspaceSourceMapEntry[] = sourceElements.map(element => {
    const sourceId = element.getAttribute('data-ui-source-id')!;
    const ancestry: string[] = [];
    let ancestor = element.parentElement?.closest('[data-ui-source-id]');
    while (ancestor) {
      const ancestorId = ancestor.getAttribute('data-ui-source-id');
      if (ancestorId) ancestry.unshift(ancestorId);
      ancestor = ancestor.parentElement?.closest('[data-ui-source-id]') ?? null;
    }
    return {
      sourceId,
      file: 'index.html',
      line: lines.get(sourceId) ?? 1,
      selector: `[data-ui-source-id="${sourceId}"]`,
      styleClasses: [...element.classList].filter(className => className.startsWith('ui-snapshot-style-')),
      ancestry
    };
  });

  return {
    html,
    css,
    outline: JSON.stringify({ version: 2, nodes }, null, 2),
    sourceMap: JSON.stringify({ version: 2, entries: sourceMapEntries }, null, 2)
  };
}

export function refreshWorkspaceIndexes(html: string): Pick<CompiledSourceWorkspace, 'outline' | 'sourceMap'> {
  const { outline, sourceMap } = compileSourceWorkspace(html);
  return { outline, sourceMap };
}
