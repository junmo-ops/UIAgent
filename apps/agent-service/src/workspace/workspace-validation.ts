import type { WorkspaceFiles } from './workspace-types';
import { validateHtml, validateCss } from './source-validation';
import { compileModuleSource, validateModuleJavaScript, validateModuleBindings } from './module-compiler';

export function validateWorkspaceFiles(files: WorkspaceFiles): void {
  validateHtml(files['index.html']);
  validateCss(files['snapshot.css']);
  validateCss(files['author-overrides.css']);
  compileModuleSource(files['module.jsx']);
  validateModuleJavaScript(files['module.js']);
  validateModuleBindings(files['index.html'], files['module.jsx']);
  JSON.parse(files['outline.json']);
  JSON.parse(files['source-map.json']);
}
