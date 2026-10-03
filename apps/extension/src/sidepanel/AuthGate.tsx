import {getExistingInstallationCredential} from '../service/installation-credential';
import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {Alert,Button,Spin,Modal,message} from 'antd';
import {getAgentServiceUrl,agentServiceUrlItem} from '../service/agent-service-config';
import {getAuthConfig,getSsoAccessToken,clearSsoSession,loginSso,logoutSso,ssoSessionItem} from '../service/sso-session';

const AccountActions = createContext<{ displayName?: string; busy: boolean; logout: () => void; bindLegacy: () => void } | undefined>(undefined);
export const useAccountActions = () => useContext(AccountActions);

export function AuthGate({children}:{children:ReactNode}) {
  const [origin,setOrigin]=useState(''),[attempt,setAttempt]=useState(0);
  const [status,setStatus]=useState<'loading'|'local'|'login'|'signed'|'error'>('loading');
  const [identity,setIdentity]=useState<{userId:string;displayName?:string}>();
  const [error,setError]=useState<string>(),[ready,setReady]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{
    const change=()=>setAttempt(x=>x+1);
    const invalidate=()=>{setStatus('loading');setIdentity(undefined);change();};
    const off1=ssoSessionItem.watch(invalidate),off2=agentServiceUrlItem.watch(invalidate);
    const focus=()=>{void getAgentServiceUrl().then(url=>getAuthConfig(new URL(url).origin)).then(config=>{if(config.mode==='external')change();}).catch(()=>{});};
    window.addEventListener('focus',focus);
    return()=>{off1();off2();window.removeEventListener('focus',focus);};
  },[]);
  useEffect(()=>{
    let cancelled=false;let timer:ReturnType<typeof setTimeout>|undefined;
    void (async()=>{
      const serviceOrigin=new URL(await getAgentServiceUrl()).origin;
      const config=await getAuthConfig(serviceOrigin);
      if(cancelled)return;
      setOrigin(serviceOrigin);setReady(config.ready);
      if(config.mode!=='external'){setStatus('local');return;}
      const token=await getSsoAccessToken(serviceOrigin);
      if(!token){if(!cancelled){setIdentity(undefined);setStatus('login');setError(config.ready?undefined:config.message);}return;}
      const response=await fetch(`${serviceOrigin}/v1/auth/me`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
      if(response.status===401){await clearSsoSession(serviceOrigin);return;}
      if(!response.ok)throw new Error('无法验证当前登录状态');
      const user=await response.json();
      if(typeof user.userId!=='string')throw new Error('登录身份无效');
      if(!cancelled){setIdentity(user);setError(undefined);setStatus('signed');
        const credential=(await ssoSessionItem.getValue())[serviceOrigin];
        if(credential)timer=setTimeout(()=>setAttempt(x=>x+1),Math.max(0,Date.parse(credential.expiresAt)-Date.now()));}
    })().catch(e=>{if(!cancelled){setStatus('error');setError(e instanceof Error?e.message:'登录服务暂不可用');}});
    return()=>{cancelled=true;if(timer)clearTimeout(timer);};
  },[attempt]);
  const bindLegacy=async()=>{
    setBusy(true);setError(undefined);
    try {
      const previous=await getExistingInstallationCredential(origin),token=await getSsoAccessToken(origin);
      if(!previous || !token)throw new Error('此浏览器没有可关联的旧安装身份');
      const headers={'Content-Type':'application/json',authorization:`Bearer ${token}`};
      const listed=await fetch(`${origin}/v1/auth/sso/legacy-workspaces`,{method:'POST',headers,body:JSON.stringify({installationToken:previous.accessToken}),signal:AbortSignal.timeout(15000)});
      if(!listed.ok)throw new Error('无法读取旧副本，请确认旧身份仍有效且服务保留了原签名密钥');
      const data=await listed.json() as {items:{workspaceId:string}[];total:number};
      if(!data.items.length){message.info('没有待关联的旧副本');return;}
      Modal.confirm({title:'关联旧副本到当前账号？',content:`将关联 ${data.items.length} 个副本及其历史对话（共 ${data.total} 个待关联）。关联后归当前登录账号所有。`,okText:'关联副本',cancelText:'取消',onOk:async()=>{
        const response=await fetch(`${origin}/v1/auth/sso/bind-installation`,{method:'POST',headers,body:JSON.stringify({installationToken:previous.accessToken,workspaceIds:data.items.map(item=>item.workspaceId)}),signal:AbortSignal.timeout(120000)});
        if(!response.ok){message.error('关联失败，请重新登录后重试');return;}
        const result=await response.json() as {results:{ok:boolean}[]};
        const completed=result.results.filter(item=>item.ok).length;
        message.info(`已关联 ${completed} 个副本${completed<result.results.length?'，未成功的副本可稍后重试':''}`);
        setAttempt(x=>x+1);
      }});
    }catch(e){setError(e instanceof Error?e.message:'关联失败');}finally{setBusy(false);}
  };
  if(status==='local') return children;
  if(status==='loading') return <div className="sso-login"><Spin/><p>正在检查登录状态…</p></div>;
  const action=async(login:boolean)=>{
    setBusy(true);setError(undefined);
    try{if(login)await loginSso(origin);else await logoutSso(origin);setAttempt(x=>x+1);}
    catch(e){setError(e instanceof Error?e.message:'登录操作失败');}finally{setBusy(false);}
  };
  if(status!=='signed') return <div className="sso-login"><h2>登录 UI 需求助手</h2><p>使用行内账号登录，访问你的副本和对话。</p>
    {error && <Alert type="warning" title={error}/>}
    <Button type="primary" loading={busy} disabled={!ready || status==='error'} onClick={()=>void action(true)}>行内登录</Button>
    <Button type="text" onClick={()=>setAttempt(x=>x+1)}>重新检查</Button>
  </div>;
  return <AccountActions.Provider value={{ displayName: identity?.displayName, busy, logout: () => void action(false), bindLegacy: () => void bindLegacy() }}>
    <div className="sso-shell">
      {error && <Alert type="warning" title={error}/>}
      <div className="sso-body" key={`${origin}:${identity?.userId}`}>{children}</div>
    </div>
  </AccountActions.Provider>;
}
