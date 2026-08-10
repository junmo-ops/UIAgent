import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface AuthPrincipal {
  userId: string;
  tenantId: string;
  roles: string[];
  identityType?: 'development' | 'installation' | 'external';
}

export interface InstallationCredential {
  accessToken: string;
  expiresAt: string;
}

export interface Authenticator {
  mode?: 'development' | 'installation' | 'external';
  configurationError?: string;
  authenticate(request: Request): AuthPrincipal | undefined | Promise<AuthPrincipal | undefined>;
  issueInstallation?(): InstallationCredential;
  refreshInstallation?(principal: AuthPrincipal): InstallationCredential | undefined;
  createPreviewToken?(principal: AuthPrincipal, workspaceId: string): string;
}

export const LOCAL_DEVELOPMENT_PRINCIPAL: AuthPrincipal = {
  userId: 'local-developer',
  tenantId: 'local',
  roles: ['user', 'admin'],
  identityType: 'development'
};

interface InstallationClaims {
  version: 1;
  kind: 'installation' | 'preview';
  subject: string;
  tenantId: string;
  issuedAt: number;
  expiresAt: number;
  workspaceId?: string;
}

const TOKEN_PREFIX = 'uia1';

function normalizedIdentity(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function positiveSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  return match?.[1]?.trim();
}

class InstallationTokenAuthenticator implements Authenticator {
  readonly mode = 'installation' as const;

  constructor(
    private readonly secret: string,
    private readonly tenantId: string,
    private readonly accessTtlSeconds: number,
    private readonly previewTtlSeconds: number
  ) {}

  authenticate(request: Request): AuthPrincipal | undefined {
    const accessClaims = this.verify(bearerToken(request));
    if (accessClaims?.kind === 'installation') return this.principal(accessClaims);

    if (request.method !== 'GET') return undefined;
    const url = new URL(request.url);
    const previewClaims = this.verify(url.searchParams.get('preview_token') ?? undefined);
    if (previewClaims?.kind !== 'preview' || !previewClaims.workspaceId) return undefined;
    if (url.pathname !== `/workspaces/${previewClaims.workspaceId}/preview`) return undefined;
    return this.principal(previewClaims);
  }

  issueInstallation(): InstallationCredential {
    return this.installationCredential(randomUUID());
  }

  refreshInstallation(principal: AuthPrincipal): InstallationCredential | undefined {
    return principal.identityType === 'installation'
      ? this.installationCredential(principal.userId)
      : undefined;
  }

  createPreviewToken(principal: AuthPrincipal, workspaceId: string): string {
    const now = Math.floor(Date.now() / 1000);
    return this.sign({
      version: 1,
      kind: 'preview',
      subject: principal.userId,
      tenantId: principal.tenantId,
      workspaceId,
      issuedAt: now,
      expiresAt: now + this.previewTtlSeconds
    });
  }

  private installationCredential(subject: string): InstallationCredential {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.accessTtlSeconds;
    return {
      accessToken: this.sign({
        version: 1,
        kind: 'installation',
        subject,
        tenantId: this.tenantId,
        issuedAt: now,
        expiresAt
      }),
      expiresAt: new Date(expiresAt * 1000).toISOString()
    };
  }

  private principal(claims: InstallationClaims): AuthPrincipal {
    return {
      userId: claims.subject,
      tenantId: claims.tenantId,
      roles: ['user'],
      identityType: 'installation'
    };
  }

  private sign(claims: InstallationClaims): string {
    const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const message = `${TOKEN_PREFIX}.${encoded}`;
    const signature = createHmac('sha256', this.secret).update(message).digest('base64url');
    return `${message}.${signature}`;
  }

  private verify(token: string | undefined): InstallationClaims | undefined {
    if (!token) return undefined;
    const [prefix, encoded, signature, extra] = token.split('.');
    if (prefix !== TOKEN_PREFIX || !encoded || !signature || extra) return undefined;
    const expected = createHmac('sha256', this.secret)
      .update(`${prefix}.${encoded}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      return undefined;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<InstallationClaims>;
      if (claims.version !== 1 || (claims.kind !== 'installation' && claims.kind !== 'preview')) return undefined;
      if (typeof claims.subject !== 'string' || typeof claims.tenantId !== 'string') return undefined;
      if (!Number.isInteger(claims.issuedAt) || !Number.isInteger(claims.expiresAt)) return undefined;
      if (claims.expiresAt! <= Math.floor(Date.now() / 1000)) return undefined;
      if (claims.kind === 'preview' && typeof claims.workspaceId !== 'string') return undefined;
      return claims as InstallationClaims;
    } catch {
      return undefined;
    }
  }
}

export function createAuthenticatorFromEnvironment(env: NodeJS.ProcessEnv): Authenticator {
  const mode = env.AUTH_MODE?.trim().toLowerCase()
    ?? (env.NODE_ENV === 'production' ? 'required' : 'development');

  if (mode === 'installation') {
    const secret = env.INSTALLATION_TOKEN_SECRET?.trim();
    if (!secret || secret.length < 32) {
      return {
        mode: 'installation',
        configurationError: 'INSTALLATION_TOKEN_SECRET 必须至少包含 32 个字符',
        authenticate: () => undefined
      };
    }
    return new InstallationTokenAuthenticator(
      secret,
      normalizedIdentity(env.INSTALLATION_TENANT_ID, 'internal-pilot'),
      positiveSeconds(env.INSTALLATION_TOKEN_TTL_SECONDS, 365 * 24 * 60 * 60),
      positiveSeconds(env.PREVIEW_TOKEN_TTL_SECONDS, 7 * 24 * 60 * 60)
    );
  }

  if (mode === 'development') {
    if (env.NODE_ENV === 'production' && env.ALLOW_INSECURE_DEV_AUTH !== 'true') {
      return {
        mode: 'development',
        configurationError: '生产环境禁止使用开发身份认证',
        authenticate: () => undefined
      };
    }
    const principal: AuthPrincipal = {
      userId: normalizedIdentity(env.DEV_AUTH_USER_ID, LOCAL_DEVELOPMENT_PRINCIPAL.userId),
      tenantId: normalizedIdentity(env.DEV_AUTH_TENANT_ID, LOCAL_DEVELOPMENT_PRINCIPAL.tenantId),
      roles: ['user', 'admin'],
      identityType: 'development'
    };
    return { mode: 'development', authenticate: () => principal };
  }

  // Production identity providers are injected through this port. Until an adapter is
  // configured, fail closed instead of trusting a user ID supplied by the client.
  return {
    mode: 'external',
    configurationError: '生产环境尚未配置身份提供方',
    authenticate: () => undefined
  };
}

export function staticAuthenticator(principal: AuthPrincipal): Authenticator {
  return { authenticate: () => principal };
}
