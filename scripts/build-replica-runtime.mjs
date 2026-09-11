import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(projectRoot, 'packages/replica-component-runtime');
const entryPoint = resolve(runtimeRoot, 'src/index.tsx');
const outputFile = resolve(projectRoot, 'apps/agent-service/replica-runtime/ui-agent-select.js');
const runtimeRequire = createRequire(resolve(runtimeRoot, 'package.json'));

async function loadEsbuild() {
  try {
    return await import(runtimeRequire.resolve('esbuild'));
  } catch {
    const workspaceFallback = resolve(projectRoot, 'node_modules/.pnpm/node_modules/esbuild/lib/main.js');
    if (!existsSync(workspaceFallback)) {
      throw new Error('缺少 esbuild，请先在主仓库安装依赖');
    }
    return import(pathToFileURL(workspaceFallback).href);
  }
}

const { build } = await loadEsbuild();
mkdirSync(dirname(outputFile), { recursive: true });
await build({
  entryPoints: [entryPoint],
  outfile: outputFile,
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome120'],
  nodePaths: [resolve(projectRoot, 'node_modules/.pnpm/node_modules')],
  logLevel: 'info'
});
