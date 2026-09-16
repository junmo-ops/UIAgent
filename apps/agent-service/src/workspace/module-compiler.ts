import { Script } from 'node:vm';
import { transformSync } from 'esbuild';
import { parseHTML } from 'linkedom';

export function compileModuleSource(source: string): string {
  if (source.length > 500_000) throw new Error('module.jsx 超过 500 KB 限制');
  if (!source.trim()) return '';
  try {
    const result = transformSync(source, {
      loader: 'jsx',
      sourcefile: 'module.jsx',
      target: 'chrome120',
      format: 'iife',
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      legalComments: 'none',
      charset: 'utf8'
    });
    if (result.code.length > 1_000_000) throw new Error('编译产物超过 1 MB 限制');
    return result.code;
  } catch (error) {
    const failure = error as { errors?: Array<{ text?: string; location?: { line?: number; column?: number } | null }> };
    const diagnostic = failure.errors?.slice(0, 5).map(item => {
      const location = item.location?.line
        ? `module.jsx:${item.location.line}:${(item.location.column ?? 0) + 1}`
        : 'module.jsx';
      return `${location} ${item.text ?? '编译失败'}`;
    }).join('；');
    throw new Error(`module.jsx 编译失败：${diagnostic || (error instanceof Error ? error.message : '未知错误')}`);
  }
}

export function validateModuleJavaScript(source: string): string {
  if (source.length > 1_000_000) throw new Error('module.js 超过 1 MB 限制');
  if (!source.trim()) return 'module.js 为空';
  try {
    // Syntax validation only. Generated code is never evaluated by the service;
    // The shared browser runtime mounts it directly into the replica document.
    new Script(source, { filename: 'module.js' });
  } catch (error) {
    throw new Error(`module.js 语法无效：${error instanceof Error ? error.message : '未知语法错误'}`);
  }
  return 'module.js 语法校验通过';
}

export function validateModuleBindings(html: string, source: string): void {
  const { document } = parseHTML(html);
  const requested = new Set(
    [...document.querySelectorAll('ui-agent-module')]
      .map(element => element.getAttribute('module')?.trim())
      .filter((name): name is string => Boolean(name))
  );
  if (!requested.size) return;
  const definitions = new Set(
    [...source.matchAll(/\bUIAgent\s*\.\s*define\s*\(\s*(['"])([a-z][a-z0-9-]{0,79})\1\s*,/g)]
      .map(match => match[2]!)
  );
  const missing = [...requested].filter(name => !definitions.has(name));
  if (missing.length) {
    throw new Error(`module.jsx 未定义宿主引用的模块：${missing.join('、')}。请使用 UIAgent.define(name, factory) 注册`);
  }
}
