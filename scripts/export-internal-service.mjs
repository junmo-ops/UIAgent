import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { internalServiceLockfile } from './internal-service-lockfile.mjs';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArgument = process.argv[2] === '--' ? process.argv[3] : process.argv[2];
const internalNpmRegistry = 'http://central.jaf.cmbchina.cn/artifactory/api/npm/group-npm/';
const deploymentPnpmVersion = '10.33.0';
const servicePaths = ['apps/agent-service', 'packages/agent-runtime', 'packages/contracts'];
const replicaRuntimeArtifact = resolve(projectRoot, 'apps/agent-service/replica-runtime/ui-agent-module.js');
const internalLockfilePath = resolve(projectRoot, 'scripts/internal-service-pnpm-lock.yaml');
// The internal lockfile is a verified deployment baseline. Do not resolve it from
// the full workspace lockfile: unrelated installs could silently upgrade server packages.
const deploymentLockfile = internalServiceLockfile(
  readFileSync(internalLockfilePath, 'utf8'),
  Object.fromEntries(servicePaths.map(path => [path, JSON.parse(readFileSync(resolve(projectRoot, path, 'package.json'), 'utf8'))]))
);

if (!outputArgument) {
  throw new Error('请指定交付目录，例如：pnpm export:internal-service -- ../ui-agent-service');
}

if (!existsSync(replicaRuntimeArtifact)) {
  throw new Error('缺少副本局部组件运行产物，请先执行 pnpm run build:replica-runtime');
}

const outputDirectory = resolve(projectRoot, outputArgument);
const outputRelativeToProject = relative(projectRoot, outputDirectory);
if (!outputRelativeToProject.startsWith('..') || isAbsolute(outputRelativeToProject)) {
  throw new Error('交付目录必须位于当前项目目录之外，避免将生成文件混入源码仓库。');
}

const projectRelativeToOutput = relative(outputDirectory, projectRoot);
if (!projectRelativeToOutput.startsWith('..') || isAbsolute(projectRelativeToOutput) || outputDirectory === dirname(outputDirectory)) {
  throw new Error('交付目录不能是当前项目的上级目录或文件系统根目录。');
}

if (existsSync(outputDirectory)) {
  const outputStat = lstatSync(outputDirectory);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    throw new Error(`交付路径必须是普通目录，不能是文件或符号链接：${outputDirectory}`);
  }
  for (const entry of readdirSync(outputDirectory)) {
    if (entry === '.git') continue;
    rmSync(resolve(outputDirectory, entry), { recursive: true, force: true });
  }
}
mkdirSync(outputDirectory, { recursive: true });

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
  start: servicePackage.scripts.start,
  'package:extension': servicePackage.scripts['package:extension']
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
writeFileSync(resolve(outputDirectory, 'Dockerfile'), `FROM node:22-bookworm-slim\n\nENV PNPM_HOME=/pnpm\nENV PATH=$PNPM_HOME:$PATH\nENV NODE_ENV=production\nENV HOST=0.0.0.0\nENV PORT=8787\n\nWORKDIR /app\n\nCOPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./\nCOPY apps/agent-service/package.json apps/agent-service/package.json\nCOPY packages/agent-runtime/package.json packages/agent-runtime/package.json\nCOPY packages/contracts/package.json packages/contracts/package.json\nRUN npm install --global pnpm@${deploymentPnpmVersion} --registry=${internalNpmRegistry} \\\n  && pnpm install --prod --frozen-lockfile\n\nCOPY apps/agent-service apps/agent-service\nCOPY packages/agent-runtime packages/agent-runtime\nCOPY packages/contracts packages/contracts\n\nRUN pnpm --filter @ui-agent/agent-service package:extension \\\n  && mkdir -p /data/source-workspaces /data/logs\n\nEXPOSE 8787\n\nCMD ["pnpm", "--filter", "@ui-agent/agent-service", "start"]\n`);
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

cpSync(resolve(projectRoot, 'apps/agent-service/.env.example'), resolve(outputDirectory, 'apps/agent-service/.env.example'));
cpSync(resolve(projectRoot, 'docs/副本对象存储部署说明.md'), resolve(outputDirectory, 'STORAGE.md'));
cpSync(resolve(projectRoot, 'docs/服务配置说明.md'), resolve(outputDirectory, 'CONFIGURATION.md'));
writeFileSync(resolve(outputDirectory, 'pnpm-lock.yaml'), deploymentLockfile);

const exportedExtensionManifestPath = resolve(outputDirectory, 'apps/agent-service/extension-release/manifest.json');
const exportedExtensionFilesManifestPath = resolve(outputDirectory, 'apps/agent-service/extension-release/files/manifest.json');
let exportedExtensionVersion;
if (existsSync(exportedExtensionManifestPath) && existsSync(exportedExtensionFilesManifestPath)) {
  try {
    const release = JSON.parse(readFileSync(exportedExtensionManifestPath, 'utf8'));
    if (typeof release.version === 'string') exportedExtensionVersion = release.version;
  } catch {
    // 服务端会把不完整或无效的更新产物视为“暂无更新”。
  }
}

writeFileSync(resolve(outputDirectory, 'README.md'), `# UI Agent Service - Internal Deployment Source\n\n该目录由 UIAgent 主仓库自动生成，是独立的服务端部署工程。它不携带插件源码、Demo、测试或开发依赖；Dockerfile 是唯一的构建入口。\n\n## 本地调试\n\n\`\`\`bash\nnpx --yes pnpm@${deploymentPnpmVersion} install\ncp apps/agent-service/.env.example apps/agent-service/.env\nnpx --yes pnpm@${deploymentPnpmVersion} dev\n\`\`\`\n\n使用 \`npx pnpm@${deploymentPnpmVersion}\` 可避免本机全局 pnpm 或 Corepack 版本干扰。\n\n## 内部流水线\n\n- 构建引擎：Node.js 22.9.0\n- 自动化编译脚本：\`test -f Dockerfile && test -f pnpm-lock.yaml\`\n- 容器制品发布步骤：使用根目录 \`Dockerfile\` 构建并发布镜像\n- 不要在流水线宿主机执行 \`pnpm install\`、\`tsc\` 或测试命令\n\nDockerfile 使用行内 npm 制品库安装固定的 \`pnpm@${deploymentPnpmVersion}\` 与运行时依赖；不会使用 Corepack。\n\n## 服务单元\n\n配置监听端口 \`8787\`、HTTP 健康检查路径 \`/health\`，普通参数填写 \`apps/agent-service/config/service.json\` 与 \`workspace-storage.json\`，仅密钥通过平台 Secret 注入，详见 [配置说明](CONFIGURATION.md)。\n\n## 插件更新包\n\n${exportedExtensionVersion ? `当前交付包内置 Chrome 插件 v${exportedExtensionVersion} 的构建文件。Git 仓库不保存 ZIP；Docker 镜像构建时生成 ZIP，运行中的服务通过 \`/v1/extension/latest\` 提供版本信息，并通过 \`/v1/extension/download\` 直接返回该文件。` : '当前交付包未包含插件构建文件，插件更新检查会保持关闭；如需发布插件更新，请先在主仓库执行 `pnpm run build:extension` 后重新导出。'}\n\n环境文件、密钥、日志和工作区数据均不应提交。每次修改主仓库的服务端依赖后，请重新执行导出命令生成新的部署仓库。\n`);

appendFileSync(resolve(outputDirectory, 'README.md'), '\n## 导出与依赖预检\n\n导出是离线操作，复用 `scripts/internal-service-pnpm-lock.yaml` 中经行内验证的服务端精确版本，不访问 npm 源，也不会额外安装前端依赖。只有行内预检和流水线安装需要网络。新增依赖或升级版本前必须先确认行内 npm 源存在对应版本，再更新基线锁文件并执行 `npm run check:internal-deploy`（主仓库命令）。\n');
appendFileSync(resolve(outputDirectory, 'README.md'), '\n## 副本局部组件\n\n交付包已包含预构建的 React 与 Ant Design 浏览器运行时。模型生成的 JSX 保存在每个副本的 `module.jsx` 中，Agent Service 使用 esbuild 生成只读的 `module.js`，再由共享运行时直接挂载到副本 DOM。无需 JSON UI Schema 或按组件注册适配器。健康检查中的 `replicaComponentRuntimeReady` 应为 `true`。\n');
appendFileSync(resolve(outputDirectory, 'README.md'), '\n## 副本持久化\n\n行内部署请按 [对象存储部署说明](STORAGE.md) 配置 S3、迁移旧数据并使用空缓存启动。单实例发布；存活探针 `/live`，就绪探针 `/ready`。密钥由平台 Secret 注入。\n');
console.log(`已离线生成内部服务端独立部署包：${outputDirectory}`);
console.log(exportedExtensionVersion
  ? `已包含 Chrome 插件构建文件 v${exportedExtensionVersion}，Docker 镜像构建时将生成 ZIP`
  : '未发现 Chrome 插件构建文件，本次交付不会启用插件更新提示');
