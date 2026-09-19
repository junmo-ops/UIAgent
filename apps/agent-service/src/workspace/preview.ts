import { type WorkspaceFiles } from './workspace-types';
import { validateModuleJavaScript, validateModuleBindings } from './module-compiler';
import { validateAuthorCss, validateHtml, validateCss } from './source-validation';
import { escapeHtmlAttribute } from './source-document';
import type { AuthorStyleResource, AuthorStyleSheet } from '@ui-agent/contracts';

export interface WorkspacePreviewInput {
  files: WorkspaceFiles;
  candidate: 'A' | 'B';
  assetQuery: string;
  workspaceAssetPath?: string;
  authorResources: AuthorStyleResource[];
  unreadableStyleSources: string[];
  authorSheets: AuthorStyleSheet[];
  authorCss?: string;
  authorRulesAvailable: boolean;
}

/** Pure rendering: never writes source, creates revisions, or invokes the Agent. */
export function renderWorkspacePreview(input: WorkspacePreviewInput): string | undefined {
  const { files, candidate, assetQuery, workspaceAssetPath = '',
    authorResources, unreadableStyleSources,
    authorSheets, authorCss, authorRulesAvailable } = input;
  const html = files['index.html'];
  const css = files['snapshot.css'];
  const authorOverrides = files['author-overrides.css'];
  validateHtml(html);
  if (css) validateCss(css);
  if (authorOverrides) validateCss(authorOverrides);
  validateModuleJavaScript(files['module.js']);
  validateModuleBindings(html, files['module.jsx']);
  let previewCss = css;
  let style = `<style data-ui-agent-workspace-styles data-ui-agent-candidate="A">\n${previewCss}\n</style>`;
  if (candidate === 'B') {
    if (!authorRulesAvailable) return undefined;
    // B intentionally has no frozen snapshot rules. The capture frame fixes
    // the page to the original viewport and causes overflow in responsive
    // layouts; computed classes would also override the author cascade.
    previewCss = '';
    const orderedStyleLinks = authorSheets.length
      ? authorSheets.map((sheet, index) => {
        const attributes = `${sheet.media ? ` media="${escapeHtmlAttribute(sheet.media)}"` : ''}${sheet.disabled ? ' disabled' : ''}`;
        if (sheet.sourceKind === 'inline' && !sheet.renderOnly && sheet.cssText !== undefined) {
          validateAuthorCss(sheet.cssText, []);
          // A disabled attribute on <style> is not equivalent to sheet.disabled.
          const media = sheet.disabled ? 'not all' : sheet.media;
          return `<style${media ? ` media="${escapeHtmlAttribute(media)}"` : ''} data-ui-agent-author-styles data-ui-agent-candidate="B">${sheet.cssText}</style>`;
        }
        return sheet.renderOnly
          ? `<link rel="stylesheet" href="${escapeHtmlAttribute(sheet.sourceUrl)}"${attributes} data-ui-agent-render-only-stylesheet>`
          : `<link rel="stylesheet" href="${workspaceAssetPath}author-sheets/${index}${assetQuery}"${attributes} data-ui-agent-author-styles data-ui-agent-candidate="B">`;
      }
      ).join('\n')
      : `${authorCss
        ? `<link rel="stylesheet" href="${workspaceAssetPath}author.css${assetQuery}" data-ui-agent-author-styles data-ui-agent-candidate="B">`
        : ''}${unreadableStyleSources.map(source => `\n<link rel="stylesheet" href="${escapeHtmlAttribute(source)}" data-ui-agent-render-only-stylesheet>`).join('')}`;
    style = `${orderedStyleLinks}\n<link rel="stylesheet" href="${workspaceAssetPath}author-overrides.css${assetQuery}" data-ui-agent-author-overrides>`;
  }
  const localizedHtml = localizeSnapshotResources(html, authorResources);
  const componentRuntime = /<ui-agent-module\b/i.test(localizedHtml)
    ? `<script src="${workspaceAssetPath}replica-runtime.js${assetQuery}" defer data-ui-agent-replica-runtime="module-v2"></script>\n<script src="${workspaceAssetPath}module.js${assetQuery}" defer data-ui-agent-module-source></script>\n`
    : '';
  return /<\/head>/i.test(localizedHtml)
    ? localizedHtml.replace(/<\/head>/i, () => `${style}\n${componentRuntime}</head>`)
    : localizedHtml.replace(/<body\b/i, () => `${style}\n${componentRuntime}<body`);
}

function localizeSnapshotResources(html: string, resources: AuthorStyleResource[]): string {
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
