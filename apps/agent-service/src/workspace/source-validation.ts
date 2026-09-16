import { parseHTML } from 'linkedom';
import { MAX_STATIC_SNAPSHOT_HTML_CHARS, type AuthorStyleResource } from '@ui-agent/contracts';

export const UNSAFE_HTML_RULES = [
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

export const URL_BEARING_ATTRIBUTES = new Set([
  'href', 'src', 'srcset', 'action', 'formaction', 'poster', 'xlink:href'
]);

export function normalizeUrlProtocol(value: string): string {
  // Browsers ignore ASCII whitespace and control characters while resolving a
  // scheme. Normalize them before checking so `java&#x0A;script:` cannot evade
  // the attribute-level guard.
  return value.trim().replace(/[\u0000-\u0020\u007f]+/g, '').toLocaleLowerCase();
}

export function containsUnsafeCssExecutableContent(css: string): boolean {
  const executableCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\b(?:expression\s*\(|-moz-binding\b|behavior\s*:)/i.test(executableCss)) return true;
  for (const match of executableCss.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (normalizeUrlProtocol(target).startsWith('javascript:')) return true;
  }
  return false;
}

export function validateCssResourceUrls(css: string, errorMessage: string): void {
  for (const match of css.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim().toLowerCase();
    if (target.startsWith('#') || target.startsWith('data:') || /^https?:\/\//i.test(target)) continue;
    throw new Error(errorMessage);
  }
}

export function validateEmbeddedHtmlSafety(html: string): void {
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

export function validateAuthorCss(css: string, _resources: AuthorStyleResource[]): string {
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

export function cssImportSources(css: string): string[] {
  const sources: string[] = [];
  const pattern = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')/gi;
  for (const match of css.matchAll(pattern)) {
    const source = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (source) sources.push(source);
  }
  return sources;
}

export function validateHtml(html: string): string {
  if (!/<!doctype html>/i.test(html) || !/<html\b/i.test(html) || !/<body\b/i.test(html)) {
    throw new Error('index.html 缺少完整的 doctype、html 或 body 结构');
  }
  const unsafe = UNSAFE_HTML_RULES.find(rule => rule.pattern.test(html));
  if (unsafe) throw new Error(`源码包含脚本、事件、远程资源或其他不安全内容（检测到：${unsafe.label}）`);
  validateEmbeddedHtmlSafety(html);
  validateReplicaComponents(html);
  validateTableStructure(html);
  if (html.length > MAX_STATIC_SNAPSHOT_HTML_CHARS) {
    throw new Error(`index.html 超过 ${Math.round(MAX_STATIC_SNAPSHOT_HTML_CHARS / 1_000_000)} MB 限制`);
  }
  return 'HTML 与安全规则校验通过';
}

export function validateReplicaComponents(html: string): void {
  const { document } = parseHTML(html);
  const components = [...document.querySelectorAll('ui-agent-module')];
  if (components.length > 50) throw new Error('单个副本最多允许 50 个局部组件');
  const commonAttributes = new Set([
    'data-ui-source-id', 'data-ui-agent-source-rect', 'data-ui-agent-captured-layout',
    'data-ui-component', 'data-testid',
    'id', 'class', 'style', 'title', 'role', 'aria-label', 'hidden', 'tabindex'
  ]);
  for (const component of components) {
    if (component.children.length || component.textContent?.trim()) {
      throw new Error(`${component.localName} 必须是空宿主，不能包含子元素或文本`);
    }
    for (const attribute of [...component.attributes]) {
      const name = attribute.name.toLowerCase();
      const supported = commonAttributes.has(name)
        || /^aria-[a-z][a-z-]*$/.test(name)
        || name === 'module';
      if (!supported) {
        throw new Error(`${component.localName} 不支持属性 ${attribute.name}`);
      }
    }
    const moduleName = component.getAttribute('module')?.trim();
    if (!moduleName) throw new Error('ui-agent-module 缺少 module 属性');
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(moduleName)) {
      throw new Error('ui-agent-module 的 module 必须是小写字母开头、仅含小写字母/数字/连字符的稳定名称');
    }
  }
  for (const element of [...document.querySelectorAll('*')]) {
    if (element.localName.startsWith('ui-agent-') && element.localName !== 'ui-agent-module') {
      throw new Error(`不支持的局部组件宿主 ${element.localName}`);
    }
  }
}

export function validateCss(css: string): string {
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

export function validateTableStructure(html: string): void {
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
