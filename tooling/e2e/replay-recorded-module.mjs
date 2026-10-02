// Replay recorded preview HTML and generated JSX without service/model access.
// This diagnoses interaction checks; it does not replace the original E2E result.
import { chromium, expect } from '@playwright/test';
import { compileModuleSource } from '../../apps/agent-service/src/workspace/module-compiler.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const dir = resolve(process.argv[2]);
const evidence = JSON.parse(readFileSync(resolve(dir,'evaluation.json'),'utf8'));
const recorded = JSON.parse(execFileSync('python3',['-c', `import zipfile,json,sys
z=zipfile.ZipFile(sys.argv[1]); out={}
for name in z.namelist():
 if name.endswith('.network'):
  for line in z.read(name).decode().splitlines():
   s=json.loads(line).get('snapshot',{});r=s.get('response',{});c=r.get('content',{});u=s.get('request',{}).get('url','')
   if r.get('status')==200 and c.get('_file') and ('/preview?' in u or u.endswith('/author-overrides.css')):
    out[u]={'body':z.read(c['_file']).decode(),'type':c['mimeType']}
print(json.dumps(out))`, resolve(dir,'trace.zip')],{encoding:'utf8'}));
let jsx = '';
for (const t of evidence.turns) for (const log of t.logs) for (const step of log.sourceSteps ?? []) {
  if (step.action !== 'apply_patch' || step.outcome !== 'succeeded' || step.input.path !== 'module.jsx') continue;
  for (const edit of step.input.edits) {
    if (edit.kind === 'insert') jsx = edit.position === 'start' ? edit.text + jsx : jsx + edit.text;
    else if (edit.kind === 'replace' && jsx.includes(edit.search)) jsx = jsx.replace(edit.search, edit.replace);
    else throw new Error('Unsupported recorded JSX operation; replay aborted');
  }
}
if (!jsx) throw new Error('No recorded JSX');
const runtime = readFileSync(new URL('../../apps/agent-service/replica-runtime/ui-agent-module.js',import.meta.url));
const compiled = compileModuleSource(jsx);
const url = Object.keys(recorded).find(u=>u.includes('/preview?'));
if (!url) throw new Error('No recorded preview');
const browser = await chromium.launch({channel:'chromium',headless:true});
const page = await browser.newPage({viewport:evidence.case.viewport ?? {width:894,height:805}});
const result = { caseId:evidence.case.id, kind:'offline-recorded-module-replay', modelCalls:0, runtimeSha256:createHash('sha256').update(runtime).digest('hex'), jsxSha256:createHash('sha256').update(jsx).digest('hex'), actions:[], blockedRequests:[] };
try {
 await page.route('**/*',async route=>{
   const u=route.request().url();
   if (recorded[u]) return route.fulfill({status:200,contentType:recorded[u].type,body:recorded[u].body});
   if (u===new URL('module.js',url).href) return route.fulfill({status:200,contentType:'text/javascript',body:compiled});
   if (u===new URL('replica-runtime.js',url).href) return route.fulfill({status:200,contentType:'text/javascript',body:runtime});
   result.blockedRequests.push({url:u,method:route.request().method()}); await route.abort();
 });
 await page.goto(url);
 for(const [index,action] of evidence.case.actions.entries()) {
  const check={action,outcome:'passed'};
  try {
   if(action.kind==='click') {
    const name = new RegExp('^'+Array.from(action.name).map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s*')+'$');
    await page.getByRole(action.role,{name}).click({timeout:4000});
   }
   if(action.kind==='fill') await page.getByLabel(action.label,{exact:true}).fill(action.value,{timeout:4000});
   if(action.kind==='visible') await expect(page.getByText(action.text,{exact:true})).toBeVisible({timeout:4000});
   if(action.kind==='hidden') await expect(page.getByText(action.text,{exact:true})).toBeHidden({timeout:4000});
  }catch(error){check.outcome='failed';check.error=String(error);}
  result.actions.push(check);
  await page.screenshot({path:resolve(dir,`replay-action-${index+1}.png`),fullPage:true});
 }
}finally{
 writeFileSync(resolve(dir,'offline-replay.json'),JSON.stringify(result,null,2)); await browser.close();
}
console.log(JSON.stringify({caseId:result.caseId,actions:result.actions.map(a=>({action:a.action,outcome:a.outcome})),blockedRequests:result.blockedRequests}));
if(result.actions.some(a=>a.outcome==='failed')) process.exitCode=1;
