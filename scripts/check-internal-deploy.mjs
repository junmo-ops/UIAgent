import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const registry = process.env.INTERNAL_NPM_REGISTRY
  ?? 'http://central.jaf.cmbchina.cn/artifactory/api/npm/group-npm/';
const pnpmVersion = '10.33.0';
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const checkDirectory = mkdtempSync(resolve(tmpdir(), 'ui-agent-internal-deploy-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      INTERNAL_NPM_REGISTRY: registry,
      UI_AGENT_LOCKFILE_REGISTRY: registry,
      npm_config_registry: registry
    }
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`命令执行失败：${command} ${args.join(' ')}`);
  }
  process.stdout.write(result.stdout);
}

try {
  console.log(`使用行内 npm 源预检服务端部署依赖：${registry}`);
  run(process.execPath, ['scripts/export-internal-service.mjs', checkDirectory], projectRoot);
  run(
    npxCommand,
    ['--yes', `pnpm@${pnpmVersion}`, 'install', '--prod', '--frozen-lockfile'],
    checkDirectory,
  );
  console.log('通过：行内部署包可完成生产依赖安装。');
} finally {
  if (existsSync(checkDirectory)) rmSync(checkDirectory, { recursive: true, force: true });
}
