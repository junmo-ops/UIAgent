import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createExtensionZip } from '../src/extension/archive.ts';

const releaseDirectory = fileURLToPath(new URL('../extension-release/', import.meta.url));
const releaseManifestPath = fileURLToPath(new URL('../extension-release/manifest.json', import.meta.url));
const releaseFilesPath = fileURLToPath(new URL('../extension-release/files/', import.meta.url));
const releaseZipPath = fileURLToPath(new URL('../extension-release/ui-agent-extension.zip', import.meta.url));

const hasManifest = existsSync(releaseManifestPath);
const hasFiles = existsSync(releaseFilesPath);

if (!hasManifest && !hasFiles) {
  console.log('未包含插件构建文件，跳过插件 ZIP 生成');
  process.exit(0);
}
if (!hasManifest || !hasFiles) {
  throw new Error('插件发布内容不完整：版本清单和构建文件目录必须同时存在');
}

const release = JSON.parse(readFileSync(releaseManifestPath, 'utf8'));
if (typeof release.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(release.version)) {
  throw new Error('插件发布版本无效，无法生成 ZIP');
}

const archive = createExtensionZip(releaseFilesPath);
writeFileSync(releaseZipPath, archive);
rmSync(releaseFilesPath, { recursive: true, force: true });
console.log(`Chrome 插件 v${release.version} ZIP 已在镜像构建阶段生成，共 ${archive.byteLength} 字节`);
