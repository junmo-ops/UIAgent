import type { AuthorStyleResource, AuthorStyleSheet } from '@ui-agent/contracts';

export interface AuthorStyleCapture {
  cssText: string;
  readableSheets: number;
  unreadableSheets: number;
  missing: string[];
  sources?: string[];
  unreadableSources?: string[];
  sheets?: AuthorStyleSheet[];
  resources?: AuthorStyleResource[];
}

function resourceKind(cssPrefix: string): AuthorStyleResource['kind'] {
  // The prefix includes the declarations between `@font-face {` and `url()`.
  // Checking only for `@font-face` directly before the URL misclassified every
  // font once `font-family` or `src` had been emitted.
  return /@font-face\s*\{[^{}]*$/i.test(cssPrefix)
    ? 'font'
    : /(?:mask|cursor|content)\s*:/i.test(cssPrefix)
      ? 'other'
      : 'image';
}

/**
 * Rewrites resource URLs without flattening conditional CSS rules. This is a
 * syntax-aware scanner for url() tokens, not a rule extractor: @media,
 * @supports and @font-face therefore retain their original nesting/order.
 */
export function sanitizeAuthorCssText(cssText: string, sourceUrl: string): {
  cssText: string;
  filteredRules: number;
  resources: AuthorStyleResource[];
} {
  const resources: AuthorStyleResource[] = [];
  let filteredRules = 0;
  let output = '';
  let cursor = 0;
  const urlToken = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
  const importToken = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')([^;]*);/gi;
  // An imported stylesheet is a stylesheet dependency, not a binary resource.
  // Sending it through the asset proxy changes its base URL, so relative URLs
  // inside the imported file would resolve against the workspace instead.
  const importRanges = Array.from(cssText.matchAll(importToken)).map(match => {
    const start = match.index ?? 0;
    return { start, end: start + match[0].length };
  });
  for (const match of cssText.matchAll(urlToken)) {
    const start = match.index ?? 0;
    output += cssText.slice(cursor, start);
    cursor = start + match[0].length;
    if (importRanges.some(range => start >= range.start && start < range.end)) {
      output += match[0];
      continue;
    }
    const rawTarget = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!rawTarget || rawTarget.startsWith('#') || rawTarget.startsWith('data:')) {
      output += match[0];
      continue;
    }
    try {
      const url = new URL(rawTarget, sourceUrl);
      if (!/^https?:$/i.test(url.protocol)) throw new Error('unsupported protocol');
      resources.push({ url: url.toString(), sourceUrl, kind: resourceKind(cssText.slice(Math.max(0, start - 500), start)) });
      output += `url("${url.toString().replace(/"/g, '%22')}")`;
    } catch {
      // Preserve the surrounding rule and neutralize only the unsafe resource.
      output += 'url("")';
      filteredRules += 1;
    }
  }
  output += cssText.slice(cursor);
  // Keep import conditions and make their URL absolute. Imported stylesheets
  // participate in the author's cascade before the remaining parent rules.
  output = output.replace(importToken,
    (token, doubleQuoted, singleQuoted, bare, quoted, singleQuotedImport, suffix) => {
      const target = (doubleQuoted ?? singleQuoted ?? bare ?? quoted ?? singleQuotedImport ?? '').trim();
      try {
        const url = new URL(target, sourceUrl);
        if (!/^https?:$/i.test(url.protocol)) throw new Error('unsupported protocol');
        return `@import url("${url.toString().replace(/"/g, '%22')}")${suffix};`;
      } catch {
        filteredRules += 1;
        return '/* ui-agent: removed unsafe @import */';
      }
    });
  if (/expression\s*\(|-moz-binding\s*:|behavior\s*:/i.test(output)) {
    filteredRules += 1;
    output = output.replace(/expression\s*\([^)]*\)|-moz-binding\s*:[^;{}]+;?|behavior\s*:[^;{}]+;?/gi, '');
  }
  return { cssText: output, filteredRules, resources };
}

/**
 * Collects author CSS only when the browser permits CSSOM access. Cross-origin
 * sheets are reported as missing instead of being fetched or silently replaced
 * with computed styles. This is the observation primitive for the B candidate.
 */
export function captureAccessibleAuthorStyles(documentRef: Document = document): AuthorStyleCapture {
  const chunks: string[] = [];
  const missing: string[] = [];
  const unreadableSources: string[] = [];
  const sheets: AuthorStyleSheet[] = [];
  let readableSheets = 0;
  let unreadableSheets = 0;
  const resources: AuthorStyleResource[] = [];
  for (const sheet of Array.from(documentRef.styleSheets)) {
    const href = sheet.href || documentRef.location.href;
    const sourceKind = sheet.href ? 'external' as const : 'inline' as const;
    const media = sheet.media.mediaText.trim();
    const disabled = Boolean(sheet.disabled);
    try {
      const rules = sheet.cssRules;
      const rawCss = Array.from(rules).map(rule => rule.cssText).join('\n');
      const sanitized = sanitizeAuthorCssText(rawCss, sheet.href || sheet.ownerNode?.baseURI || documentRef.baseURI);
      const filteredCount = sanitized.filteredRules;
      if (filteredCount > 0) missing.push(`${href}（过滤 ${filteredCount} 条不安全规则）`);
      chunks.push(`/* source: ${href.replace(/[\r\n*]/g, ' ')} */\n${sanitized.cssText}`);
      sheets.push({ sourceUrl: href, sourceKind, cssText: sanitized.cssText, renderOnly: false, ...(media ? { media } : {}), ...(disabled ? { disabled } : {}) });
      resources.push(...sanitized.resources);
      readableSheets += 1;
    } catch {
      unreadableSheets += 1;
      missing.push(href);
      if (/^https?:\/\//i.test(href)) unreadableSources.push(href);
      if (/^https?:\/\//i.test(href)) sheets.push({ sourceUrl: href, sourceKind, renderOnly: true, ...(media ? { media } : {}), ...(disabled ? { disabled } : {}) });
    }
  }
  return {
    cssText: chunks.join('\n\n'), readableSheets, unreadableSheets, missing,
    sources: Array.from(documentRef.styleSheets).map(sheet => sheet.href || documentRef.location.href),
    unreadableSources: [...new Set(unreadableSources)],
    sheets,
    resources
  };
}
