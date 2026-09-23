import { resolve } from 'node:path';
import { serviceDirectory, readConfigurationFile } from '../configuration/files';
import { z } from 'zod';
import { defaultArchiveLimits } from './workspace-archive';

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({
  mode: z.enum(['local', 's3']),
  cacheDirectory: z.string().trim().min(1),
  s3: z.object({
    endpoint: z.string().trim(), region: z.string().trim(), bucket: z.string().trim(),
    prefix: z.string().trim(), timeoutMs: positiveInteger.default(60000)
  }).strict(),
  archive: z.object({
    bytes: positiveInteger.default(defaultArchiveLimits.bytes),
    compressedBytes: positiveInteger.default(defaultArchiveLimits.compressedBytes),
    files: positiveInteger.default(defaultArchiveLimits.files)
  }).strict().default(defaultArchiveLimits)
}).strict();

export type WorkspaceStorageConfig = z.infer<typeof schema>;
export function readWorkspaceStorageConfig(): WorkspaceStorageConfig {
  const root = serviceDirectory();
  let config: WorkspaceStorageConfig;
  try { config = schema.parse(readConfigurationFile('workspace-storage.json')); }
  catch { throw new Error('无法读取 config/workspace-storage.json，请检查文件、字段和 JSON 格式；密钥只能通过环境变量提供'); }
  if (config.mode === 's3' && ['endpoint', 'region', 'bucket', 'prefix'].some(key => !config.s3[key as 'endpoint' | 'region' | 'bucket' | 'prefix'])) {
    throw new Error('config/workspace-storage.json 的 S3 地址、区域、桶名和前缀不能为空');
  }
  return { ...config, cacheDirectory: resolve(root, config.cacheDirectory) };
}
