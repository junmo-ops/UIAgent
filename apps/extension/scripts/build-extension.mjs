import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(
  fileURLToPath(new URL(process.platform === 'win32' ? '../node_modules/.bin/wxt.CMD' : '../node_modules/.bin/wxt', import.meta.url)),
  ['build', '--browser', 'chrome'],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      WXT_PUBLIC_AGENT_SERVICE_URL: process.env.WXT_PUBLIC_AGENT_SERVICE_URL ?? 'https://ui-agent-dev.paas.cmbchina.cn'
    }
  }
);
process.exit(result.status ?? 1);
