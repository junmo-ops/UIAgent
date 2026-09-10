import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const extensionDirectory = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const result = spawnSync(
  fileURLToPath(new URL(process.platform === 'win32' ? '../node_modules/.bin/wxt.CMD' : '../node_modules/.bin/wxt', import.meta.url)),
  ['build', '--browser', 'chrome'],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: extensionDirectory,
    env: {
      ...process.env,
      WXT_PUBLIC_AGENT_SERVICE_URL: process.env.WXT_PUBLIC_AGENT_SERVICE_URL ?? 'https://ui-agent-dev.paas.cmbchina.cn'
    }
  }
);
if (result.status !== 0) process.exit(result.status ?? 1);

const releaseDirectory = fileURLToPath(new URL('../../agent-service/extension-release/', import.meta.url));
const releaseFilesDirectory = fileURLToPath(new URL('../../agent-service/extension-release/files/', import.meta.url));
const builtExtensionDirectory = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url));
rmSync(releaseDirectory, { recursive: true, force: true });
mkdirSync(releaseDirectory, { recursive: true });
cpSync(builtExtensionDirectory, releaseFilesDirectory, { recursive: true });
writeFileSync(fileURLToPath(new URL('../../agent-service/extension-release/manifest.json', import.meta.url)), `${JSON.stringify({
  version: packageJson.version,
  releaseNotes: process.env.EXTENSION_RELEASE_NOTES?.trim() || undefined,
  publishedAt: new Date().toISOString()
}, null, 2)}\n`);

console.log(`插件构建文件已同步到 ${releaseDirectory}，Docker 镜像构建时将生成 ZIP`);
