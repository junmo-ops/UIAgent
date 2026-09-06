import { parseHTML } from 'linkedom';

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

export interface SourceWorkspaceCompileOptions {
  viewport?: { width: number; height: number };
  /** Author-rule snapshots need original inline declarations and their cascade priority. */
  preserveInlineStyles?: boolean;
}

function normalizeLegacyDeclaration(declaration: string): string {
  return declaration.replace(
    /font-family:(["'])([^;]*,[^;]*)\1(?=;|$)/gi,
    (_match, _quote: string, fontStack: string) => `font-family:${fontStack.trim()}`
  );
}

function frozenViewportCss(viewport: SourceWorkspaceCompileOptions['viewport']): string | undefined {
  if (!viewport) return undefined;
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  return [
    '/* Keep imported snapshots in the capture-time coordinate system. */',
    `html,body{width:100%;min-width:${width}px;min-height:${height}px}`,
    'body{padding:0!important}',
    '/* Keep scrolling available while hiding page and nested container scrollbars. */',
    '*{scrollbar-width:none;-ms-overflow-style:none}',
    '*::-webkit-scrollbar{display:none;width:0;height:0}',
    `[data-ui-agent-snapshot-stage]{display:block;width:${width}px!important;min-width:${width}px!important;min-height:${height}px;margin:0 auto;transform:translateZ(0)}`
  ].join('\n');
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

function sourceReadableHtml(html: string): string {
  // 标签之间的换行会成为真实文本节点，破坏 inline/inline-block 布局。
  // 把换行放进开始标签内部，既保留每个 source id 的独立行号，又不改变 DOM。
  return html.replace(/\s+(?=data-ui-source-id\s*=)/gi, '\n  ');
}

function removeSerializationArtifacts(document: Document): void {
  // 捕获端或其他 HTML 序列化器在修复不规范的 <p>/<div> 嵌套时，可能补出
  // 没有 sourceId、属性、内容和子节点的空段落。它们不属于原始可编辑节点，
  // 但在预览浏览器中会命中 UA 默认 margin，导致副本出现额外纵向间距。
  for (const element of [...document.querySelectorAll('p')]) {
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

function sourceLineMap(html: string): Map<string, number> {
  const result = new Map<string, number>();
  html.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\bdata-ui-source-id\s*=\s*["']([^"']+)["']/gi)) {
      result.set(match[1]!, index + 1);
    }
  });
  return result;
}

export function compileSourceWorkspace(
  inputHtml: string,
  options: SourceWorkspaceCompileOptions = {}
): CompiledSourceWorkspace {
  const { document } = parseHTML(inputHtml);
  removeSerializationArtifacts(document);
  const baselineCss = [...document.querySelectorAll('style')]
    .map(element => element.textContent?.trim())
    .filter(Boolean);
  for (const element of [...document.querySelectorAll('style')]) element.remove();

  const styles = new Map<string, string>();
  for (const element of [...document.querySelectorAll('[style]')]) {
    // These declarations are source state, not computed-style fallback rules.
    // Converting them would discard them in the author-rules candidate.
    if (options.preserveInlineStyles) continue;
    const declaration = normalizeLegacyDeclaration(element.getAttribute('style')?.trim() ?? '');
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

  const html = sourceReadableHtml(document.toString());
  const css = [
    '/* UI Agent Workspace V2: frozen snapshot styles */',
    ...baselineCss,
    ...[...styles.entries()].map(([declaration, className]) => `.${className}{${declaration}}`),
    frozenViewportCss(options.viewport)
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
