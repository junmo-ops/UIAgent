import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { z } from 'zod';
import { WORKSPACE_FILES } from '../workspace/workspace-types';

export const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface ArchiveLimits { bytes: number; compressedBytes: number; files: number }
export const defaultArchiveLimits: ArchiveLimits = { bytes: 256 * 1024 * 1024, compressedBytes: 64 * 1024 * 1024, files: 20000 };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const metadataPath = '__uiagent_archive__.json';
const fileMetadataSchema = z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const fileSchema = fileMetadataSchema.extend({ content: z.custom<Buffer>(Buffer.isBuffer) });
const metadataSchema = z.object({ format: z.literal('uiagent-workspace'), version: z.literal(2), workspaceId: z.string(), commitId: z.string().uuid(), files: z.array(fileMetadataSchema) }).strict();
const archiveSchema = metadataSchema.extend({ files: z.array(fileSchema) });
export type WorkspaceArchive = z.infer<typeof archiveSchema>;
const manifestSchema = z.object({
  workspaceId: z.string(), title: z.string(), sourceUrl: z.string(), selectedSourceId: z.string(),
  createdAt: z.string(), updatedAt: z.string(), revision: z.number().int().nonnegative(),
  maxRevision: z.number().int().nonnegative(), summaries: z.array(z.unknown()),
  ownerId: z.string().optional(), tenantId: z.string().optional()
});
function checkPath(path: string) {
  if (!path || Buffer.byteLength(path) > 1024 || /[\\:<>"|?*\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part.startsWith('.') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || ['__proto__', 'constructor', 'prototype'].includes(part))) {
    throw new Error('副本归档包含不安全的文件路径');
  }
}
export function validateArchive(value: unknown, id: string, limits: ArchiveLimits): WorkspaceArchive {
  const archive = archiveSchema.parse(value);
  if (!workspaceIdPattern.test(id) || archive.workspaceId !== id || archive.files.length > Math.min(limits.files, 65534)) throw new Error('副本归档 ID 或文件数量无效');
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const file of archive.files) {
    checkPath(file.path);
    if (file.path.split('/')[0] === metadataPath) throw new Error('副本文件名与 ZIP 元数据保留名称冲突');
    const bytes = file.content;
    total += bytes.length;
    if (files.has(file.path) || total > limits.bytes || bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error('副本归档完整性校验失败或超出容量限制');
    files.set(file.path, bytes);
  }
  for (const name of files.keys()) {
    const segments = name.split('/');
    while (segments.length > 1) { segments.pop(); if (files.has(segments.join('/'))) throw new Error('副本归档文件路径冲突'); }
  }
  const manifest = manifestSchema.parse(JSON.parse(files.get('workspace.json')?.toString('utf8') ?? 'null'));
  if (manifest.workspaceId !== id || manifest.revision > manifest.maxRevision) throw new Error('副本清单无效');
  for (const file of WORKSPACE_FILES) {
    if (!files.has(file)) throw new Error(`副本缺少文件：${file}`);
    if (manifest.maxRevision >= limits.files) throw new Error('副本历史数量超限');
    for (let revision = 0; revision <= manifest.maxRevision; revision++) {
      if (!files.has(`revisions/${String(revision).padStart(3, '0')}/${file}`)) throw new Error('副本缺少源码历史文件');
    }
  }
  return archive;
}
export function packWorkspace(directory: string, id: string, limits: ArchiveLimits): { archive: WorkspaceArchive; body: Buffer } {
  const files: WorkspaceArchive['files'] = [];
  let size = 0;
  function walk(relative = '') {
    const path = resolve(directory, relative);
    if (lstatSync(path).isSymbolicLink()) throw new Error('副本不能包含符号链接');
    for (const name of readdirSync(path).sort()) {
      if (name.startsWith('.')) continue;
      const child = relative ? `${relative}/${name}` : name;
      const full = resolve(directory, child);
      const stat = lstatSync(full);
      if (stat.isDirectory()) { walk(child); continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('副本包含非普通文件');
      size += stat.size;
      if (size > limits.bytes || files.length >= Math.min(limits.files, 65534)) throw new Error('副本超过归档容量限制');
      const bytes = readFileSync(full);
      files.push({ path: child, size: bytes.length, sha256: digest(bytes), content: bytes });
    }
  }
  walk();
  const archive = validateArchive({ format: 'uiagent-workspace', version: 2, workspaceId: id, commitId: randomUUID(), files }, id, limits);
  const entries: Record<string, Uint8Array> = Object.create(null);
  for (const file of archive.files) entries[file.path] = file.content;
  entries[metadataPath] = Buffer.from(JSON.stringify({ ...archive, files: archive.files.map(({ content: _content, ...metadata }) => metadata) }));
  const body = Buffer.from(zipSync(entries, { level: 6 }));
  if (body.length > limits.compressedBytes) throw new Error('副本压缩对象超过容量限制');
  return { archive, body };
}
export function unpackWorkspace(body: Buffer, id: string, limits: ArchiveLimits): WorkspaceArchive {
  if (body.length > limits.compressedBytes) throw new Error('副本对象超过容量限制');
  if (body.length < 22 || body.readUInt32LE(0) !== 0x04034b50) throw new Error('副本必须为 ZIP 归档');
  const names = new Set<string>();
  const sizes = new Map<string, number>();
  let total = 0;
  const metadataLimit = limits.files * 2048 + 4096;
  // fflate allocates each output using originalSize; check it before decompression.
  const entries = unzipSync(body, { filter(file) {
    checkPath(file.name);
    if (names.has(file.name) || names.size >= limits.files + 1) throw new Error('ZIP 文件名重复或文件数量超限');
    if (![0, 8].includes(file.compression) || !Number.isSafeInteger(file.originalSize) || file.originalSize < 0
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > body.length
      || (file.compression === 0 && file.size !== file.originalSize)) throw new Error('ZIP 文件尺寸或压缩格式无效');
    if (file.name === metadataPath) {
      if (file.originalSize > metadataLimit) throw new Error('ZIP 元数据超限');
    } else {
      total += file.originalSize;
      if (total > limits.bytes) throw new Error('ZIP 解压总容量超限');
    }
    names.add(file.name);
    sizes.set(file.name, file.originalSize);
    return true;
  } });
  for (const [name, size] of sizes) {
    if (entries[name]?.length !== size) throw new Error('ZIP 文件长度校验失败');
  }
  const rawMetadata = entries[metadataPath];
  if (!rawMetadata) throw new Error('ZIP 缺少副本元数据');
  const metadata = metadataSchema.parse(JSON.parse(Buffer.from(rawMetadata).toString('utf8')));
  if (metadata.files.length !== names.size - 1) throw new Error('ZIP 文件清单不一致');
  return validateArchive({ ...metadata, files: metadata.files.map(file => {
    const content = entries[file.path];
    if (!content || file.path === metadataPath) throw new Error('ZIP 缺少清单中的源码文件');
    return { ...file, content: Buffer.from(content) };
  }) }, id, limits);
}
export function restoreWorkspace(archive: WorkspaceArchive, directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of archive.files) {
    const path = resolve(directory, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.content, { mode: 0o600, flag: 'wx' });
  }
}
export function contentFingerprint(archive: WorkspaceArchive): string {
  return digest(Buffer.from(JSON.stringify(archive.files.map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a, b) => a.path.localeCompare(b.path)))));
}
