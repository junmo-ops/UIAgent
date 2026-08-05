import { PROTOCOL_VERSION, staticSnapshotSchema, type StaticSnapshot } from '@ui-agent/contracts';

const STYLE_PROPERTIES = [
  'align-content', 'align-items', 'align-self', 'appearance', 'background-color',
  'border-bottom-color', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'border-bottom-style', 'border-bottom-width', 'border-collapse', 'border-left-color',
  'border-left-style', 'border-left-width', 'border-right-color', 'border-right-style',
  'border-right-width', 'border-spacing', 'border-top-color', 'border-top-left-radius',
  'border-top-right-radius', 'border-top-style', 'border-top-width', 'box-shadow',
  'box-sizing', 'color', 'column-gap', 'cursor', 'display', 'fill', 'flex-basis',
  'flex-direction', 'flex-grow', 'flex-shrink', 'flex-wrap', 'font-family',
  'font-size', 'font-style', 'font-weight', 'gap', 'grid-auto-columns',
  'grid-auto-flow', 'grid-auto-rows', 'grid-column', 'grid-row',
  'grid-template-columns', 'grid-template-rows', 'height', 'inset', 'top', 'right',
  'bottom', 'left', 'justify-content',
  'justify-items', 'justify-self', 'letter-spacing', 'line-height', 'list-style',
  'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'max-height',
  'max-width', 'min-height', 'min-width', 'object-fit', 'opacity', 'order',
  'outline-color', 'outline-offset', 'outline-style', 'outline-width', 'overflow',
  'overflow-wrap', 'overflow-x', 'overflow-y', 'padding-bottom', 'padding-left',
  'padding-right', 'padding-top', 'place-content', 'pointer-events', 'position',
  'resize', 'row-gap', 'stroke', 'table-layout', 'text-align', 'text-decoration',
  'text-overflow', 'text-transform', 'transform', 'transform-origin',
  'vertical-align', 'visibility', 'white-space', 'width', 'word-break', 'z-index'
] as const;

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
  return normalized.startsWith('data:image/') || normalized.startsWith('data:font/');
}

function normalizeComputedStyleValue(property: string, value: string): string {
  if (property !== 'font-family') return value;
  // 部分业务站点会把整段字体栈误写成一个带引号的字体名，例如
  // "PingFang SC,Microsoft YaHei,Arial,sans-serif"。同机运行时会静默回退，
  // 但跨系统导入后回退字体不同，文字度量会变化并引发换行。快照里还原为字体栈。
  const quotedStack = value.match(/^(["'])(.+,.+)\1$/);
  return quotedStack ? quotedStack[2]!.trim() : value;
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
  for (const property of STYLE_PROPERTIES) {
    const value = (overrides[property] ?? computed.getPropertyValue(property)).trim();
    // CSS URL 可能包含远程背景、字体或光标。静态需求示意不依赖这些资源，
    // 统一丢弃，避免混合 data:/remote fallback 绕过单值判断。
    if (!value || /url\s*\(/i.test(value)) continue;
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

function applyComputedStyle(source: Element, clone: Element): void {
  const computed = getComputedStyle(source);
  const declarations = computedStyleDeclarations(
    computed,
    preservesSingleRenderedLine(source, computed) ? { 'white-space': 'nowrap' } : {}
  );
  clone.setAttribute('style', declarations.join(';'));
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

function sanitizeElement(source: Element, clone: Element): void {
  copyLiveState(source, clone);
  applyComputedStyle(source, clone);

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

function sanitizeTree(sourceRoot: HTMLElement, cloneRoot: HTMLElement): string[] {
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
    sanitizeElement(source, clone);
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

export function captureStaticSnapshot(sourceRoot: HTMLElement): StaticSnapshot {
  const cloneRoot = sourceRoot.cloneNode(true) as HTMLElement;
  const pseudoRules = sanitizeTree(sourceRoot, cloneRoot);
  let renderedRoot = cloneRoot;
  if (sourceRoot === document.body) {
    renderedRoot = document.createElement('div');
    for (const attribute of [...cloneRoot.attributes]) {
      renderedRoot.setAttribute(attribute.name, attribute.value);
    }
    renderedRoot.innerHTML = cloneRoot.innerHTML;
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
    ${pseudoRules.join('\n    ')}
  </style>
</head>
<body data-ui-agent-static-snapshot="true">
  <main data-ui-agent-snapshot-stage>${renderedRoot.outerHTML}</main>
</body>
</html>`;

  return staticSnapshotSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    title,
    sourceUrl: location.href,
    capturedAt: new Date().toISOString(),
    html,
    nodeCount,
    selectedSourceId: 'source-0',
    viewport: {
      width: viewportWidth,
      height: viewportHeight
    }
  });
}
