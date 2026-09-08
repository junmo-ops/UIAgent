import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { internalServiceLockfile } from './internal-service-lockfile.mjs';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArgument = process.argv[2] === '--' ? process.argv[3] : process.argv[2];
const internalNpmRegistry = 'http://central.jaf.cmbchina.cn/artifactory/api/npm/group-npm/';
const deploymentPnpmVersion = '10.33.0';
const servicePaths = ['apps/agent-service', 'packages/agent-runtime', 'packages/contracts'];
// Validate before creating output. Export never invokes a package manager/network.
const deploymentLockfile = internalServiceLockfile(
  readFileSync(resolve(projectRoot, 'pnpm-lock.yaml'), 'utf8'),
  Object.fromEntries(servicePaths.map(path => [path, JSON.parse(readFileSync(resolve(projectRoot, path, 'package.json'), 'utf8'))]))
);

if (!outputArgument) {
  throw new Error('请指定一个空目录，例如：pnpm export:internal-service -- ../ui-agent-service');
}

const outputDirectory = resolve(projectRoot, outputArgument);
const outputRelativeToProject = relative(projectRoot, outputDirectory);
if (!outputRelativeToProject.startsWith('..') || isAbsolute(outputRelativeToProject)) {
  throw new Error('交付目录必须位于当前项目目录之外，避免将生成文件混入源码仓库。');
}

if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) {
  throw new Error(`交付目录必须为空：${outputDirectory}`);
}

const excludedDirectoryNames = new Set(['node_modules', 'dist', 'coverage', '.output', '.wxt', '.logs', '.snapshots']);
const excludedFileNames = new Set(['.DS_Store']);
const excludedFilePattern = /(?:\.test\.ts$|\.spec\.ts$|\.env(?:\..+)?$|\.tsbuildinfo$|\.log$)/;

function shouldCopy(sourcePath) {
  const name = sourcePath.split('/').at(-1) ?? '';
  if (excludedDirectoryNames.has(name)) return false;
  return !excludedFileNames.has(name) && !excludedFilePattern.test(name);
}

function copyRelativePath(relativePath) {
  const sourcePath = resolve(projectRoot, relativePath);
  const destinationPath = resolve(outputDirectory, relativePath);
  if (!existsSync(sourcePath)) throw new Error(`缺少交付所需文件：${relativePath}`);
  mkdirSync(dirname(destinationPath), { recursive: true });
  cpSync(sourcePath, destinationPath, { recursive: statSync(sourcePath).isDirectory(), filter: shouldCopy });
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(outputDirectory, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  writeFileSync(resolve(outputDirectory, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

[
  'apps/agent-service',
  'packages/agent-runtime',
  'packages/contracts'
].forEach(copyRelativePath);

writeJson('package.json', {
  name: 'ui-agent-service-internal',
  version: '0.1.0',
  private: true,
  packageManager: `pnpm@${deploymentPnpmVersion}`,
  scripts: {
    dev: 'pnpm --filter @ui-agent/agent-service dev',
    start: 'pnpm --filter @ui-agent/agent-service start'
  }
});

const servicePackage = readJson('apps/agent-service/package.json');
servicePackage.scripts = {
  dev: servicePackage.scripts.dev,
  start: servicePackage.scripts.start
};
delete servicePackage.devDependencies;
writeJson('apps/agent-service/package.json', servicePackage);

for (const relativePath of ['packages/agent-runtime/package.json', 'packages/contracts/package.json']) {
  const packageJson = readJson(relativePath);
  delete packageJson.scripts;
  delete packageJson.devDependencies;
  writeJson(relativePath, packageJson);
}

writeFileSync(resolve(outputDirectory, 'pnpm-workspace.yaml'), `packages:\n  - apps/agent-service\n  - packages/agent-runtime\n  - packages/contracts\n\nallowBuilds:\n  esbuild: true\n`);
writeFileSync(resolve(outputDirectory, '.npmrc'), `registry=${internalNpmRegistry}\n`);
writeFileSync(resolve(outputDirectory, '.gitignore'), `node_modules/\n.env\n.logs/\n.source-workspaces/\n`);
writeFileSync(resolve(outputDirectory, '.dockerignore'), `node_modules/\n.env\n.logs/\n.source-workspaces/\n`);
writeFileSync(resolve(outputDirectory, 'Dockerfile'), `FROM node:22-bookworm-slim\n\nENV PNPM_HOME=/pnpm\nENV PATH=$PNPM_HOME:$PATH\nENV NODE_ENV=production\nENV HOST=0.0.0.0\nENV PORT=8787\nENV SOURCE_WORKSPACE_DIR=/data/source-workspaces\nENV LOG_FILE=/data/logs/agent-turns.jsonl\n\nWORKDIR /app\n\nCOPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./\nCOPY apps/agent-service/package.json apps/agent-service/package.json\nCOPY packages/agent-runtime/package.json packages/agent-runtime/package.json\nCOPY packages/contracts/package.json packages/contracts/package.json\nRUN npm install --global pnpm@${deploymentPnpmVersion} --registry=${internalNpmRegistry} \\\n  && pnpm install --prod --frozen-lockfile\n\nCOPY apps/agent-service apps/agent-service\nCOPY packages/agent-runtime packages/agent-runtime\nCOPY packages/contracts packages/contracts\n\nRUN mkdir -p /data/source-workspaces /data/logs\n\nEXPOSE 8787\n\nCMD ["pnpm", "--filter", "@ui-agent/agent-service", "start"]\n`);
const deploymentDockerfile = resolve(outputDirectory, 'Dockerfile');
writeFileSync(
  deploymentDockerfile,
  readFileSync(deploymentDockerfile, 'utf8')
    .replace('FROM node:22-bookworm-slim', 'FROM csbase.registry.cmbchina.cn/paas/cmb-nodejs-22.22:c86-kylin10-v1')
    .replace('WORKDIR /app', 'USER root\n\nWORKDIR /opt/deployments')
    .replaceAll('/data/source-workspaces', '/opt/deployments/data/source-workspaces')
    .replaceAll('/data/logs/agent-turns.jsonl', '/opt/deployments/data/logs/agent-turns.jsonl')
    .replace('&& pnpm install --prod --frozen-lockfile', '&& pnpm install --prod --frozen-lockfile \\\n  && mkdir -p /opt/.config \\\n  && chmod -R 755 /opt/.config')
    .replace('mkdir -p /opt/deployments/data/source-workspaces /data/logs', 'chmod -R 777 /opt/deployments \\\n  && mkdir -p /opt/deployments/data/source-workspaces /opt/deployments/data/logs'),
);

writeFileSync(resolve(outputDirectory, 'apps/agent-service/.env.example'), `HOST=127.0.0.1\nPORT=8787\nAUTH_MODE=development\nMODEL_MODE=remote\nMODEL_PROVIDER=deepseek\nMODEL_BASE_URL=https://api.deepseek.com\nMODEL_API_KEY=\nMODEL_NAME=deepseek-v4-flash\n`);

writeFileSync(resolve(outputDirectory, 'pnpm-lock.yaml'), deploymentLockfile);

writeFileSync(resolve(outputDirectory, 'README.md'), `# UI Agent Service - Internal Deployment Source\n\n该目录由 UIAgent 主仓库自动生成，是独立的服务端部署工程。它不携带插件、Demo、测试或开发依赖；Dockerfile 是唯一的构建入口。\n\n## 本地调试\n\n\`\`\`bash\nnpx --yes pnpm@${deploymentPnpmVersion} install\ncp apps/agent-service/.env.example apps/agent-service/.env\nnpx --yes pnpm@${deploymentPnpmVersion} dev\n\`\`\`\n\n使用 \`npx pnpm@${deploymentPnpmVersion}\` 可避免本机全局 pnpm 或 Corepack 版本干扰。\n\n## 内部流水线\n\n- 构建引擎：Node.js 22.9.0\n- 自动化编译脚本：\`test -f Dockerfile && test -f pnpm-lock.yaml\`\n- 容器制品发布步骤：使用根目录 \`Dockerfile\` 构建并发布镜像\n- 不要在流水线宿主机执行 \`pnpm install\`、\`tsc\` 或测试命令\n\nDockerfile 使用行内 npm 制品库安装固定的 \`pnpm@${deploymentPnpmVersion}\` 与运行时依赖；不会使用 Corepack。\n\n## 服务单元\n\n配置监听端口 \`8787\`、HTTP 健康检查路径 \`/health\`，并通过平台环境变量注入模型、鉴权、CORS 等配置。\n\n环境文件、密钥、日志和工作区数据均不应提交。每次修改主仓库的服务端依赖后，请重新执行导出命令生成新的部署仓库。\n`);

appendFileSync(resolve(outputDirectory, 'README.md'), '\n## 导出与依赖预检\n\n导出是离线操作，复用主仓库锁文件的精确版本，不访问 npm 源。未引用的底层包元数据保留，不会额外安装前端依赖。只有行内预检和流水线安装需要网络；导出成功不代表锁定版本在行内可下载。依赖变更后请更新主仓库锁文件，并在行内执行 `npm run check:internal-deploy`（主仓库命令）。\n');
console.log(`已离线生成内部服务端独立部署包：${outputDirectory}`);
