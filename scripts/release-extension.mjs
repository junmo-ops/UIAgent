import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePath = `${projectRoot}/apps/extension/package.json`;
const originalPackageText = readFileSync(packagePath, 'utf8');
const packageJson = JSON.parse(originalPackageText);
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version ?? '');

if (!match) {
  throw new Error(`插件版本必须使用 major.minor.patch 格式，当前值：${packageJson.version ?? '空'}`);
}

const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
if (process.argv.includes('--dry-run')) {
  console.log(`插件版本将从 ${packageJson.version} 更新为 ${nextVersion}`);
  process.exit(0);
}

packageJson.version = nextVersion;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const releaseNotes = process.argv.slice(2).filter(argument => argument !== '--').join(' ').trim();
const result = spawnSync(
  process.execPath,
  [`${projectRoot}/apps/extension/scripts/build-extension.mjs`],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(releaseNotes ? { EXTENSION_RELEASE_NOTES: releaseNotes } : {})
    }
  }
);

if (result.status !== 0) {
  writeFileSync(packagePath, originalPackageText);
  throw new Error(`插件 v${nextVersion} 构建失败，已恢复版本 ${match[0]}`);
}

console.log(`插件 v${nextVersion} 构建文件已生成；下一步执行 pnpm run export:internal-service`);
