import { posix } from 'node:path';

// Select pnpm v9 importer blocks without re-resolving versions. Package and
// snapshot metadata is copied verbatim (including peer suffixes/integrities).
// This intentionally accepts only pnpm's generated block format, not arbitrary YAML.
function scalar(value) {
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (!value || /[\n\r]|^[[{&*!>|]/.test(value)) throw new Error('不支持的锁文件格式');
  return value;
}

function blocks(text, indent) {
  const re = new RegExp(`^ {${indent}}(\\S.*):[ \\t]*$`, 'gm');
  const matches = [...text.matchAll(re)];
  return new Map(matches.map((match, index) => [scalar(match[1]), text.slice(match.index, matches[index + 1]?.index ?? text.length)]));
}

export function internalServiceLockfile(source, manifests) {
  source = source.replaceAll('\r\n', '\n');
  if (!/^lockfileVersion: ['"]?9\.0['"]?$/m.test(source)) throw new Error('离线导出仅支持 pnpm v9 锁文件，请使用 pnpm 10 更新锁文件');
  const start = source.indexOf('\nimporters:\n');
  const end = source.indexOf('\npackages:\n', start);
  if (start < 0 || end < 0 || !source.includes('\nsnapshots:\n')) throw new Error('pnpm-lock.yaml 缺少 importers/packages/snapshots');
  const importers = blocks(source.slice(start + '\nimporters:\n'.length, end), 2);
  const selected = ['  .: {}\n'];
  for (const [path, manifest] of Object.entries(manifests)) {
    const importer = importers.get(path);
    if (!importer) throw new Error(`锁文件缺少 ${path}，请先在主仓库更新 pnpm-lock.yaml`);
    const groups = blocks(importer, 4);
    const output = [];
    for (const group of ['dependencies', 'optionalDependencies']) {
      const expected = manifest[group] ?? {};
      const entries = blocks(groups.get(group) ?? '', 6);
      if (Object.keys(expected).length !== entries.size) throw new Error(`${path} 的 ${group} 与锁文件不一致，请先更新主仓库 pnpm-lock.yaml`);
      for (const [name, specifier] of Object.entries(expected)) {
        const entry = entries.get(name);
        const locked = entry?.match(/^        specifier: (.+)$/m)?.[1];
        const version = entry?.match(/^        version: (.+)$/m)?.[1];
        if (!locked || scalar(locked) !== specifier || !version) throw new Error(`${path} 的 ${name} 与锁文件不一致，请先更新主仓库 pnpm-lock.yaml`);
        if (scalar(version).startsWith('link:') && !specifier.startsWith('workspace:')) throw new Error(`${path} 的 ${name} 使用本地 link 依赖，不能离线交付`);
        if (specifier.startsWith('workspace:')) {
          const target = scalar(version);
          if (!target.startsWith('link:') || manifests[posix.normalize(posix.join(path, target.slice(5)))]?.name !== name) {
            throw new Error(`${path} 的 ${name} 指向交付范围之外的 workspace，需先扩展服务端导出范围`);
          }
        }
      }
      if (entries.size) output.push(groups.get(group).trimEnd());
    }
    if (manifest.peerDependencies || manifest.dependenciesMeta) throw new Error(`${path} 使用了尚未支持的 peerDependencies/dependenciesMeta，需扩展离线导出后再交付`);
    selected.push(`  ${path}:${output.length ? '\n' + output.join('\n') : ' {}'}\n`);
  }
  return `${source.slice(0, start)}\nimporters:\n\n${selected.join('\n')}\n${source.slice(end + 1)}`;
}
