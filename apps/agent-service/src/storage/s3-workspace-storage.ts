import { randomUUID } from 'node:crypto';
import S3 from 'aws-sdk/clients/s3.js';
import { readWorkspaceStorageConfig, type WorkspaceStorageConfig } from './config';
import { type ArchiveLimits, unpackWorkspace, workspaceIdPattern } from './workspace-archive';

export class WorkspaceStorageError extends Error {
  constructor(message: string, readonly code = 'WORKSPACE_STORAGE_UNAVAILABLE') { super(message); }
}
export class WorkspaceCommitUncertain extends WorkspaceStorageError {
  constructor() { super('对象存储提交结果尚未确认，该副本已暂停访问；请由管理员恢复存储连接并重启服务核对。', 'WORKSPACE_COMMIT_UNCERTAIN'); }
}
export class S3WorkspaceStorage {
  readonly limits: ArchiveLimits;
  readonly location: string;
  private readonly client: S3;
  private readonly bucket: string;
  private readonly prefix: string;
  constructor(env: NodeJS.ProcessEnv, config: WorkspaceStorageConfig = readWorkspaceStorageConfig()) {
    const required = (name: string) => { const value = env[`WORKSPACE_S3_${name}`]?.trim(); if (!value) throw new Error(`缺少 WORKSPACE_S3_${name}`); return value; };
    const endpoint = new URL(config.s3.endpoint);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('对象存储 Endpoint 无效');
    this.bucket = config.s3.bucket;
    if (!this.bucket || !config.s3.region) throw new Error('配置文件缺少 S3 桶名或区域');
    this.prefix = config.s3.prefix.replace(/^\/+|\/+$/g, '');
    if (!this.prefix || this.prefix.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('对象存储必须配置有效的专用前缀');
    this.limits = config.archive;
    this.location = `${endpoint.origin}${endpoint.pathname}|${this.bucket}|${this.prefix}`;
    this.client = new S3({ endpoint: endpoint.toString(), region: config.s3.region,
      accessKeyId: required('ACCESS_KEY_ID'), secretAccessKey: required('SECRET_ACCESS_KEY'),
      sessionToken: env.WORKSPACE_S3_SESSION_TOKEN?.trim() || undefined,
      s3ForcePathStyle: true, sslEnabled: endpoint.protocol === 'https:',
      // No invisible upload retries: an ambiguous PUT freezes this workspace.
      maxRetries: 0, httpOptions: { connectTimeout: 15000, timeout: config.s3.timeoutMs }
    });
  }
  private key(id: string) {
    if (!workspaceIdPattern.test(id)) throw new Error('无效的副本 ID');
    return `${this.prefix}/v1/workspaces/${id}.zip`;
  }
  async assertDeletionPolicy() {
    try {
      const versioning = await this.client.getBucketVersioning({ Bucket: this.bucket }).promise();
      if (versioning.Status) throw new WorkspaceStorageError('第一版副本存储要求从未启用版本控制的专用桶，以维持永久删除语义。');
    } catch (error) {
      if (error instanceof WorkspaceStorageError) throw error;
      throw new WorkspaceStorageError('无法核验桶版本策略，请授权 GetBucketVersioning；禁止跳过永久删除策略核验。');
    }
  }
  async verifyAccess() {
    const key = `${this.prefix}/v1/probes/${randomUUID()}`;
    const body = randomUUID();
    try {
      await this.client.putObject({ Bucket: this.bucket, Key: key, Body: body }).promise();
      const object = await this.client.getObject({ Bucket: this.bucket, Key: key }).promise();
      if (object.Body?.toString() !== body) throw new Error('probe mismatch');
      await this.client.deleteObject({ Bucket: this.bucket, Key: key }).promise();
    } catch {
      throw new WorkspaceStorageError('对象存储读写删除权限验证失败，请核对专用前缀权限及连接');
    }
  }
  async list(): Promise<string[]> {
    const ids: string[] = [];
    const prefix = `${this.prefix}/v1/workspaces/`;
    let token: string | undefined;
    do {
      const page = await this.client.listObjectsV2({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }).promise();
      for (const item of page.Contents ?? []) {
        const key = item.Key ?? '';
        const id = key.slice(prefix.length).replace(/\.zip$/, '');
        if (key !== `${prefix}${id}.zip` || !workspaceIdPattern.test(id)) throw new WorkspaceStorageError('专用前缀包含无法识别的副本对象');
        ids.push(id);
      }
      const next = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && (!next || next === token)) throw new WorkspaceStorageError('对象存储分页响应无效');
      token = next;
    } while (token);
    return ids;
  }
  async read(id: string) {
    const request = this.client.getObject({ Bucket: this.bucket, Key: this.key(id) });
    const stream = request.createReadStream();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > this.limits.compressedBytes) { request.abort(); throw new WorkspaceStorageError('远端副本超过容量限制'); }
        chunks.push(bytes);
      }
      return unpackWorkspace(Buffer.concat(chunks), id, this.limits);
    } catch (error) {
      if ((error as { code?: string }).code === 'NoSuchKey') return undefined;
      if (error instanceof WorkspaceStorageError) throw error;
      throw new WorkspaceStorageError('读取或校验远端副本失败');
    }
  }
  async put(id: string, body: Buffer, commitId: string) {
    try {
      await this.client.putObject({ Bucket: this.bucket, Key: this.key(id), Body: body, ContentType: 'application/zip', Metadata: { commitid: commitId } }).promise();
    } catch (error) {
      try { if ((await this.read(id))?.commitId === commitId) return; } catch { /* Remain uncertain. */ }
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500 && status !== 408) throw new WorkspaceStorageError('对象存储拒绝保存，原副本未修改');
      throw new WorkspaceCommitUncertain();
    }
  }
  async delete(id: string) {
    try {
      await this.client.deleteObject({ Bucket: this.bucket, Key: this.key(id) }).promise();
      if (await this.read(id)) throw new WorkspaceCommitUncertain();
    } catch (error) {
      if (error instanceof WorkspaceCommitUncertain) throw error;
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500 && status !== 408) throw new WorkspaceStorageError('对象存储拒绝删除，原副本保留');
      throw new WorkspaceCommitUncertain();
    }
  }
}
