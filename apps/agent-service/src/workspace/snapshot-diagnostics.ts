import type { AuthorStyleResource } from '@ui-agent/contracts';

export interface SnapshotDiagnostics {
  htmlChars: number;
  cssChars: number;
  outlineChars: number;
  sourceMapChars: number;
  totalChars: number;
  cssRuleCount: number;
  cssDeclarationCount: number;
  cssCustomPropertyCount: number;
  generatedStyleRuleCount: number;
  generatedStyleChars: number;
  dataResourceChars: number;
  cssShare: number;
  generatedStyleShare: number;
  dataResourceShare: number;
  authorCssChars: number;
  authorResourceCount: number;
  authorResourceOriginCount: number;
  /** Unique known external stylesheet URLs, including direct @import targets. */
  authorRenderOnlyStyleCount: number;
  authorResourceFailureCount: number;
}

/**
 * Produces explainable, format-agnostic diagnostics for a workspace package.
 * This intentionally does not rewrite or normalize CSS: it is an observation
 * primitive for the A/B capture experiment.
 */
export function diagnoseSnapshotPackage(files: {
  html: string;
  css: string;
  outline?: string;
  sourceMap?: string;
  authorCss?: string;
  authorResources?: AuthorStyleResource[];
  authorRenderOnlyStyleCount?: number;
  authorResourceFailureCount?: number;
}): SnapshotDiagnostics {
  const rules = files.css.match(/[^{}]+\{[^{}]*\}/g) ?? [];
  const declarations = files.css.match(/(?:^|;)\s*[\w-]+\s*:/g) ?? [];
  const customProperties = files.css.match(/(?:^|;)\s*--[\w-]+\s*:/g) ?? [];
  const generatedRules = rules.filter(rule => /\.ui-snapshot-style-\d+\s*\{/.test(rule));
  const dataResources = [files.html, files.css].join('\n').match(/data:(?:image|font)\/[^"'\s)]+/gi) ?? [];
  const totalChars = files.html.length + files.css.length + (files.outline?.length ?? 0) + (files.sourceMap?.length ?? 0);
  return {
    htmlChars: files.html.length,
    cssChars: files.css.length,
    outlineChars: files.outline?.length ?? 0,
    sourceMapChars: files.sourceMap?.length ?? 0,
    totalChars,
    cssRuleCount: rules.length,
    cssDeclarationCount: declarations.length,
    cssCustomPropertyCount: customProperties.length,
    generatedStyleRuleCount: generatedRules.length,
    generatedStyleChars: generatedRules.reduce((sum, rule) => sum + rule.length, 0),
    dataResourceChars: dataResources.reduce((sum, resource) => sum + resource.length, 0),
    cssShare: totalChars === 0 ? 0 : files.css.length / totalChars,
    generatedStyleShare: files.css.length === 0 ? 0 : generatedRules.reduce((sum, rule) => sum + rule.length, 0) / files.css.length,
    dataResourceShare: totalChars === 0 ? 0 : dataResources.reduce((sum, resource) => sum + resource.length, 0) / totalChars
    ,authorCssChars: files.authorCss?.length ?? 0,
    authorResourceCount: files.authorResources?.length ?? 0,
    authorResourceOriginCount: new Set((files.authorResources ?? []).map(resource => new URL(resource.url).origin)).size,
    authorRenderOnlyStyleCount: files.authorRenderOnlyStyleCount ?? 0,
    authorResourceFailureCount: files.authorResourceFailureCount ?? 0
  };
}
