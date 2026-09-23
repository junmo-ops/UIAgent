import { resolve } from 'node:path';
import { z } from 'zod';
import { readConfigurationFile, serviceDirectory } from './files';

const text = z.string().trim().min(1);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const httpUrl = z.string().trim().refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}, '必须是无凭证的 HTTP/HTTPS 地址');
const schema = z.object({
  model: z.object({ baseUrl: httpUrl, name: text, providerLabel: text,
    edit: z.object({ maxIterations: positiveInteger, maxOutputTokens: positiveInteger }).strict(),
    router: z.object({ maxIterations: positiveInteger.max(5) }).strict()
  }).strict(),
  auth: z.object({ mode: z.enum(['auto', 'installation', 'development', 'external']),
    installation: z.object({ tenantId: text, tokenTtlSeconds: positiveInteger, previewTokenTtlSeconds: positiveInteger }).strict(),
    development: z.object({ userId: text, tenantId: text }).strict()
  }).strict(),
  http: z.object({ publicBaseUrl: z.union([z.literal(''), httpUrl]), corsOrigin: z.union([z.literal(''), z.literal('*'), httpUrl]) }).strict(),
  logging: z.object({ file: text }).strict(),
  diagnostics: z.object({ replicaAEnabled: z.boolean() }).strict()
}).strict();

export type ServiceConfig = z.infer<typeof schema>;
export function readServiceConfig(): ServiceConfig {
  const result = schema.safeParse(readConfigurationFile('service.json'));
  if (!result.success) throw new Error(`config/service.json 配置无效，请检查字段：${result.error.issues.map(issue => issue.path.join('.')).join(', ')}；密钥只能通过环境变量注入`);
  return { ...result.data, logging: { file: resolve(serviceDirectory(), result.data.logging.file) } };
}
