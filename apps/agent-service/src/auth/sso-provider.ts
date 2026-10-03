import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import type { ServiceConfig } from '../configuration/service-config';

export type SsoConfig = NonNullable<ServiceConfig['auth']['sso']>;
export interface SsoIdentity { openId: string; displayName: string; expiresAt: number }
const require = createRequire(import.meta.url);
export class SsoProtocolError extends Error {}
interface Sm2 {
  generateKeyPairHex(entropy:string, radix:number): {privateKey:string;publicKey:string};
  verifyPublicKey(key:string):boolean;
  doSignature(message: string, key: string, options: { hash: boolean; der: boolean; userId: string; pointPool:{length:number;pop:()=>{k:unknown;x1:unknown}} }): string;
  doVerifySignature(message: string, signature: string, key: string, options: { hash: boolean; der: boolean; userId: string }): boolean;
}
function keyHex(value: string, bytes: number): string {
  const trimmed = value.trim();
  const hex = new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(trimmed)
    ? trimmed : Buffer.from(trimmed, 'base64').toString('hex');
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(hex)) throw new SsoProtocolError('SSO 密钥格式无效');
  if (bytes === 65 && !hex.startsWith('04')) throw new SsoProtocolError('SSO 公钥必须为非压缩点');
  return hex;
}
export class SsoProvider {
  private readonly sm2: Sm2;
  private readonly privateKey: string;
  private readonly BigInteger: new (value:string,radix:number)=>unknown;
  private readonly publicKey: string;
  constructor(private readonly config: SsoConfig, privateKey: string) {
    this.sm2 = (require('sm-crypto') as { sm2: Sm2 }).sm2;
    this.BigInteger = createRequire(require.resolve('sm-crypto'))('jsbn').BigInteger;
    this.privateKey = keyHex(privateKey, 32);
    this.publicKey = keyHex(config.centerPublicKey, 65);
    if (!this.sm2.verifyPublicKey(this.publicKey)) throw new SsoProtocolError('SSO 公钥不在曲线上');
    const scalar=BigInt('0x'+this.privateKey);
    if(scalar<1n || scalar>=BigInt('0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFF7203DF6B21C6052B53BBF40939D54122')) throw new SsoProtocolError('SSO 私钥标量无效');
  }
  async exchange(code: string): Promise<SsoIdentity> {
    const url = new URL('/auth-server/token', this.config.baseUrl);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    // Empty body: X-Content is the empty line specified by the bank's guide.
    const headers: Record<string, string> = { Accept: '*/*', 'Content-Type': '',
      'X-ClientId': this.config.clientId, 'X-Nonce': randomBytes(24).toString('hex'), 'X-TimeStamp': String(Date.now()) };
    const canonical = ['POST', Object.entries(headers).map(([k,v]) => `${k}:${v}`).join('\n'), '', url.searchParams.toString()].join('\n');
    headers['X-Signature-Headers'] = Object.keys(headers).join(',');
    headers['X-Content'] = '';
    headers['X-Signature'] = Buffer.from(this.sm2.doSignature(canonical, this.privateKey,
      { hash:true, der:this.config.signatureFormat === 'der', userId:this.config.sm2UserId,
        // jsbn 1.1.0's default RNG falls back to Math.random in Node. Supply
        // fresh Node CSPRNG entropy on EVERY attempt, including rare SM2 retries.
        pointPool:{length:1,pop:()=>{
          const pair=this.sm2.generateKeyPairHex(randomBytes(48).toString('hex'),16);
          return {k:new this.BigInteger(pair.privateKey,16),x1:new this.BigInteger(pair.publicKey.slice(2,66),16)};
        }} }), 'hex').toString('base64');
    const response = await fetch(url, { method:'POST', headers, redirect:'error', signal:AbortSignal.timeout(15000) });
    if (!response.ok) throw new SsoProtocolError('统一认证换取身份失败');
    const body = await response.json() as { id_token?: unknown };
    if (typeof body.id_token !== 'string' || body.id_token.length > 32768) throw new SsoProtocolError('统一认证未返回有效身份令牌');
    return this.verify(body.id_token);
  }
  private verify(token: string): SsoIdentity {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new SsoProtocolError('身份令牌格式无效');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    if (header.alg !== this.config.idTokenAlgorithm || header.crit !== undefined) throw new SsoProtocolError('身份令牌算法不匹配');
    if (!this.sm2.doVerifySignature(`${parts[0]}.${parts[1]}`, Buffer.from(parts[2]!, 'base64url').toString('hex'), this.publicKey,
      { hash:true, der:this.config.signatureFormat === 'der', userId:this.config.sm2UserId })) throw new SsoProtocolError('身份令牌验签失败');
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now()/1000);
    if (!Number.isInteger(claims.exp) || claims.exp <= now
      || (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now+60))
      || (claims.iat !== undefined && (!Number.isInteger(claims.iat) || claims.iat > now+60))) throw new SsoProtocolError('身份令牌时间无效');
    if (this.config.issuer && claims.iss !== this.config.issuer) throw new SsoProtocolError('身份令牌颁发方不匹配');
    // Bank guide: aud[0] is a JSON-encoded ClientInfo; bind it to this application.
    const audience = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    if (typeof audience !== 'string' || JSON.parse(audience).id !== this.config.clientId) throw new SsoProtocolError('身份令牌不属于本应用');
    if (typeof claims.openId !== 'string' || !claims.openId.trim() || claims.openId.length > 256) throw new SsoProtocolError('身份令牌缺少用户标识');
    return {openId:claims.openId, displayName:typeof claims.userName === 'string' ? claims.userName.slice(0,100) : '', expiresAt:claims.exp*1000};
  }
}
