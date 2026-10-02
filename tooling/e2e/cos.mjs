import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const input = process.argv[2];
if (!input || !existsSync(resolve(input))) {
  console.error('Usage: npm --prefix tooling/e2e run test:cos -- /absolute/path/to/cos.local.json');
  process.exit(2);
}
for (const name of ['WORKSPACE_S3_ACCESS_KEY_ID', 'WORKSPACE_S3_SECRET_ACCESS_KEY']) {
  if (!process.env[name]?.trim()) { console.error(`Missing ${name}; inject credentials through environment variables.`); process.exit(2); }
}
const child = spawn(process.execPath, [resolve(directory, 'node_modules/playwright/cli.js'), 'test', '--config', resolve(directory, 'playwright.config.mjs'), '--grep', 'COS real'], {
  cwd: directory, env: { ...process.env, E2E_COS_CONFIG: resolve(input) }, stdio: 'inherit'
});
child.on('error', () => { console.error('Unable to start COS tests'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
