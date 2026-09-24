import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function serviceDirectory() {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = resolve(directory, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@ui-agent/agent-service') return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error('无法定位服务端配置目录');
    directory = parent;
  }
}
export function readConfigurationFile(name: string): unknown {
  const directory = resolve(serviceDirectory(), 'config');
  const localName = name.replace(/\.json$/, '.local.json');
  const selected = process.env.NODE_ENV !== 'production' && existsSync(resolve(directory, localName)) ? localName : name;
  try { return JSON.parse(readFileSync(resolve(directory, selected), 'utf8')); }
  catch { throw new Error(`无法读取 config/${selected}，请检查文件和 JSON 格式`); }
}
