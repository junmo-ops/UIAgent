import { storage } from 'wxt/utils/storage';
import { installationCredentialSchema, type InstallationCredential } from '@ui-agent/contracts';

// Session storage is restricted to trusted extension contexts by default.
export const ssoSessionItem = storage.defineItem<Record<string,InstallationCredential>>('session:agentSsoSessions',{fallback:{}});
const configCache = new Map<string,{expires:number;value:Promise<{mode:string;ready:boolean;message?:string}>}>();
export async function getAuthConfig(origin:string) {
  const cached=configCache.get(origin);if(cached && cached.expires>Date.now()) return cached.value;
  const value=fetch(`${origin}/v1/auth/config`,{signal:AbortSignal.timeout(10000),cache:'no-store'}).then(async response=>{
    if(response.status===404) return {mode:'installation',ready:true};
    if(!response.ok) throw new Error('无法读取服务登录配置');
    const body=await response.json();
    if(!['external','installation','development'].includes(body.mode) || typeof body.ready!=='boolean') throw new Error('服务登录配置无效');
    return body as {mode:string;ready:boolean;message?:string};
  }).catch(error=>{configCache.delete(origin);throw error;});
  configCache.set(origin,{expires:Date.now()+30000,value});return value;
}
export async function clearSsoSession(origin:string) {
  const value=await ssoSessionItem.getValue();delete value[origin];await ssoSessionItem.setValue(value);
}
export async function getSsoAccessToken(origin:string) {
  const session=(await ssoSessionItem.getValue())[origin];
  if(session && Date.parse(session.expiresAt)>Date.now()) return session.accessToken;
  if(session) await clearSsoSession(origin);
  return undefined;
}
const encode=(data:Uint8Array)=>btoa(String.fromCharCode(...data)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export async function loginSso(origin:string) {
  const verifier=encode(crypto.getRandomValues(new Uint8Array(32))),state=encode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  const redirectUri=browser.identity.getRedirectURL('sso');
  const start=new URL('/v1/auth/sso/start',origin);
  for(const [k,v] of Object.entries({challenge,clientState:state,redirectUri})) start.searchParams.set(k,v);
  let result:string|undefined;
  try { result=await browser.identity.launchWebAuthFlow({url:start.toString(),interactive:true}); }
  catch { throw new Error('登录未完成，请重试；若提示插件未登记，请联系管理员配置插件 ID'); }
  if(!result) throw new Error('登录已取消');
  const returned=new URL(result),expected=new URL(redirectUri);
  if(returned.origin!==expected.origin || returned.pathname!==expected.pathname || returned.searchParams.get('state')!==state) throw new Error('登录回调校验失败');
  const response=await fetch(`${origin}/v1/auth/sso/exchange`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ticket:returned.searchParams.get('ticket'),verifier}),signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('登录凭证已失效，请重新登录');
  const credential=installationCredentialSchema.parse(await response.json());
  await ssoSessionItem.setValue({...await ssoSessionItem.getValue(),[origin]:credential});
}
export async function logoutSso(origin:string) {
  const token=await getSsoAccessToken(origin);
  if(token) {
    const response=await fetch(`${origin}/v1/auth/sso/logout`,{method:'POST',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
    if(!response.ok && response.status!==401) throw new Error('退出失败，请稍后重试');
  }
  await clearSsoSession(origin);
}
