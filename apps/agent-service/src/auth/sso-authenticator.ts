import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import type { Authenticator, AuthPrincipal, InstallationCredential } from './authenticator';
import { SsoProvider, SsoProtocolError, type SsoConfig } from './sso-provider';
const random = () => randomBytes(32).toString('base64url');
const hash = (s:string) => createHash('sha256').update(s).digest('base64url');
const bearer = (r:Request) => /^Bearer\s+(.+)$/i.exec(r.headers.get('authorization') ?? '')?.[1];
interface Session { principal:AuthPrincipal; expiresAt:number }
interface Attempt { challenge:string; redirectUri:string; clientState:string; cookieHash:string; expiresAt:number }
interface Ticket extends Session { challenge:string; identityExpiresAt:number }

export class SsoAuthenticator implements Authenticator {
  readonly mode = 'external' as const;
  readonly provider: SsoProvider;
  private readonly attempts = new Map<string,Attempt>();
  private readonly tickets = new Map<string,Ticket>();
  private readonly sessions = new Map<string,Session>();
  private readonly previews = new Map<string,{sessionId:string; workspaceId:string; expiresAt:number}>();
  constructor(readonly config:SsoConfig, env:NodeJS.ProcessEnv) {
    const callback = new URL(config.callbackUrl);
    if (callback.pathname !== '/v1/auth/sso/callback' || callback.search || callback.hash) throw new Error('SSO 回调路径必须为 /v1/auth/sso/callback');
    if (env.NODE_ENV === 'production' && callback.protocol !== 'https:') throw new Error('生产 SSO 回调必须使用 HTTPS');
    if (config.idTokenAlgorithm.toLowerCase() === 'none') throw new Error('SSO 禁止无签名算法');
    this.provider = new SsoProvider(config, env.SSO_PRIVATE_KEY ?? '');
    this.adminIds = new Set((env.SSO_ADMIN_USER_IDS ?? '').split(',').map(v=>v.trim()).filter(Boolean));
  }
  private readonly adminIds: Set<string>;
  private sweep() {
    const now=Date.now();
    for (const map of [this.attempts,this.tickets,this.sessions,this.previews]) for (const [key,value] of map) if (value.expiresAt<=now) map.delete(key);
  }
  authenticate(request:Request):AuthPrincipal|undefined {
    this.sweep();
    const token=bearer(request);
    if (token) return this.sessions.get(hash(token))?.principal;
    if (request.method!=='GET') return undefined;
    const url=new URL(request.url), preview=this.previews.get(hash(url.searchParams.get('preview_token') ?? ''));
    if (!preview) return undefined;
    const prefix=`/workspaces/${preview.workspaceId}/`;
    if (!url.pathname.startsWith(prefix)) return undefined;
    const path=url.pathname.slice(prefix.length);
    if (!['preview','author.css','author-overrides.css','replica-runtime.js','module.js'].includes(path) && !path.startsWith('assets/') && !path.startsWith('author-sheets/')) return undefined;
    return this.sessions.get(preview.sessionId)?.principal;
  }
  createPreviewToken(principal:AuthPrincipal, workspaceId:string):string {
    this.sweep();
    // sessionId is server-only request context, never part of /auth/me.
    const sessionId=principal.sessionId, session=sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || this.previews.size>=20000) throw new Error('登录已失效或预览凭证过多');
    const token=random();this.previews.set(hash(token),{sessionId:sessionId!,workspaceId,
      expiresAt:Math.min(session.expiresAt,Date.now()+this.config.previewTtlSeconds*1000)});return token;
  }
  routes() {
    const app=new Hono();
    app.use('*',bodyLimit({maxSize:8192}));
    app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');await next();});
    app.get('/start',c=>{
      this.sweep();
      const input=z.object({challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/),clientState:z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),redirectUri:z.string().url()}).safeParse(c.req.query());
      if (!input.success) return c.text('登录参数无效',400);
      const {challenge,clientState,redirectUri}=input.data;
      if (!this.config.extensionIds.some(id=>redirectUri===`https://${id}.chromiumapp.org/sso`)) return c.text('插件 ID 尚未登记',403);
      if(this.attempts.size>=1000) return c.text('登录请求过多，请稍后重试',429);
      const state=random(), cookie=random();
      this.attempts.set(state,{challenge,clientState,redirectUri,cookieHash:hash(cookie),expiresAt:Date.now()+300000});
      setCookie(c,`uia_sso_${state}`,cookie,{httpOnly:true,secure:this.config.callbackUrl.startsWith('https:'),sameSite:'Lax',path:'/v1/auth/sso',maxAge:300});
      const url=new URL('/auth-server/auth',this.config.baseUrl);
      for(const [key,value] of Object.entries({client_id:this.config.clientId,response_type:'code',redirect_uri:this.config.callbackUrl,state,scope:this.config.scope})) if(value) url.searchParams.set(key,value);
      return c.redirect(url.toString());
    });
    app.get('/callback',async c=>{
      this.sweep();
      const state=c.req.query('state') ?? '', attempt=this.attempts.get(state);
      if(!attempt || hash(getCookie(c,`uia_sso_${state}`) ?? '')!==attempt.cookieHash) return c.text('登录请求已过期或不属于当前浏览器，请重新登录',400);
      this.attempts.delete(state);
      deleteCookie(c,`uia_sso_${state}`,{path:'/v1/auth/sso',secure:this.config.callbackUrl.startsWith('https:')});
      const code=c.req.query('code');
      if(c.req.query('error') || !code || code.length>4096) return c.text('登录未完成，请关闭此窗口后重试',400);
      try {
        const identity=await this.provider.exchange(code);
        if(this.tickets.size>=1000) return c.text('登录请求过多，请重试',429);
        const userId=`sso:${identity.openId}`, ticket=random();
        const principal:AuthPrincipal={userId,tenantId:this.config.tenantId,roles:this.adminIds.has(userId)?['user','admin']:['user'],identityType:'external',displayName:identity.displayName};
        this.tickets.set(hash(ticket),{principal,challenge:attempt.challenge,identityExpiresAt:identity.expiresAt,expiresAt:Math.min(identity.expiresAt,Date.now()+60000)});
        const url=new URL(attempt.redirectUri);url.searchParams.set('ticket',ticket);url.searchParams.set('state',attempt.clientState);
        return c.redirect(url.toString());
      } catch (error) {
        console.warn('[sso] authentication failed:', error instanceof SsoProtocolError ? error.message : '统一认证响应处理失败');
        // Never serialize provider errors (authorization codes/tokens/keys).
        return c.text('行内身份认证失败，请管理员核对签名、验签及应用配置后重试',502);
      }
    });
    app.post('/exchange',async c=>{
      this.sweep();
      const input=z.object({ticket:z.string().regex(/^[A-Za-z0-9_-]{43}$/),verifier:z.string().regex(/^[A-Za-z0-9_-]{43,128}$/)}).strict().safeParse(await c.req.json().catch(()=>null));
      if(!input.success) return c.json({message:'登录参数无效'},400);
      const key=hash(input.data.ticket), ticket=this.tickets.get(key);
      if(!ticket || hash(input.data.verifier)!==ticket.challenge) return c.json({message:'登录凭证无效或已过期'},401);
      this.tickets.delete(key);
      if(this.sessions.size>=5000) return c.json({message:'登录会话过多'},429);
      const accessToken=random(),sessionId=hash(accessToken);
      // Provider expiry was validated above; session lifetime is independently bounded.
      const expiresAt=Math.min(ticket.identityExpiresAt,Date.now()+this.config.sessionTtlSeconds*1000);
      const principal={...ticket.principal,sessionId};
      this.sessions.set(sessionId,{principal,expiresAt});
      const credential:InstallationCredential={accessToken,expiresAt:new Date(expiresAt).toISOString()};
      return c.json(credential);
    });
    app.post('/logout',c=>{
      const token=bearer(c.req.raw);if(token) this.sessions.delete(hash(token));
      this.sweep();return c.body(null,204);
    });
    return app;
  }
}
