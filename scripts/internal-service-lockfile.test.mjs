import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { internalServiceLockfile } from './internal-service-lockfile.mjs';

const source = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const paths = ['apps/agent-service', 'packages/agent-runtime', 'packages/contracts'];
const manifests = Object.fromEntries(paths.map(path => [path, JSON.parse(readFileSync(new URL(`../${path}/package.json`, import.meta.url), 'utf8'))]));

test('exports only production importers and preserves exact dependency metadata', () => {
  const result = internalServiceLockfile(source, manifests);
  const importers = result.slice(result.indexOf('importers:'), result.indexOf('\npackages:'));
  assert.match(importers, /  \.: \{\}/);
  for (const path of paths) assert.ok(importers.includes(`  ${path}:`));
  assert.ok(!importers.includes('apps/extension:'));
  assert.ok(!importers.includes('devDependencies:'));
  assert.equal(result.slice(result.indexOf('\npackages:')), source.slice(source.indexOf('\npackages:')));
  assert.equal(result, internalServiceLockfile(source, manifests));
});
test('fails rather than resolving changed, added or removed dependencies', () => {
  for (const update of [deps => { deps.zod = '999.0.0'; }, deps => { deps.newPackage = '1'; }, deps => { delete deps.zod; }]) {
    const changed = structuredClone(manifests);
    update(changed['packages/contracts'].dependencies);
    assert.throws(() => internalServiceLockfile(source, changed), /锁文件不一致/);
  }
});
test('rejects missing importers or unsupported format', () => {
  assert.throws(() => internalServiceLockfile(source, { missing: {} }), /锁文件缺少/);
  assert.throws(() => internalServiceLockfile(source.replace("'9.0'", "'6.0'"), manifests), /仅支持/);
});
test('rejects workspace links outside the exported projects', () => {
  const changed = source.replace('link:../../packages/contracts', 'link:../../packages/not-exported');
  assert.throws(() => internalServiceLockfile(changed, manifests), /交付范围之外/);
});
