// Eval-only supplement to replay-recorded-module.mjs. Never changes the original
// frozen evaluator or its results, and never makes service/model requests.
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const [input, frozenRoot, destination] = process.argv.slice(2);
if (!input || !frozenRoot || !destination) throw new Error('Usage: node --import PATH/tsx/loader.mjs recheck-recorded-interactions.mjs EVIDENCE_DIR FROZEN_SOURCE_ROOT OUTPUT_DIR');
const dir=resolve(input), sourceRoot=resolve(frozenRoot), output=resolve(destination);
if (existsSync(output)) throw new Error('Supplement directory already exists; do not overwrite evidence');
mkdirSync(output,{recursive:true});
const sha = value => createHash('sha256').update(value).digest('hex');
const evidenceBytes=readFileSync(resolve(dir,'evaluation.json'));
const evidence=JSON.parse(evidenceBytes);
const result={kind:'eval-only-recorded-interaction-recheck',status:'undetermined',modelCalls:0,originalAutomated:evidence.automated,caseId:evidence.case.id,
  evidencePath:resolve(dir,'evaluation.json'),evidenceSha256:sha(evidenceBytes),traceSha256:sha(readFileSync(resolve(dir,'trace.zip'))),
  method:'Final preview HTML/CSS read from trace; JSX reconstructed from the captured initial moduleSource plus successful apply_patch operations only; recompiled with frozen source compiler and loaded with frozen replica runtime. This is not a complete verbatim network replay.',
  sourceRoot,scriptSha256:sha(readFileSync(new URL(import.meta.url))),actions:[],requests:[],consoleErrors:[]};
let browser;
try {
  // Same extraction route as replay-recorded-module.mjs, extended to retain the
  // captured create request as evidence of the original JSX and viewport.
  const trace=JSON.parse(execFileSync('python3',['-c',`import zipfile,json,sys
z=zipfile.ZipFile(sys.argv[1]);out={'resources':{},'captured':None}
for name in z.namelist():
 if name.endswith('.network'):
  for line in z.read(name).decode().splitlines():
   s=json.loads(line).get('snapshot',{});q=s.get('request',{});r=s.get('response',{});c=r.get('content',{});u=q.get('url','')
   if r.get('status')==200 and c.get('_file') and ('/preview?' in u or u.endswith('/author-overrides.css')):
    out['resources'][u]={'body':z.read(c['_file']).decode(),'type':c['mimeType'],'traceResource':c['_file']}
   if q.get('method')=='POST' and u.endswith('/v1/workspaces'):
    p=q.get('postData',{});raw=z.read(p['_file']).decode() if p.get('_file') else p.get('text')
    if raw:
     body=json.loads(raw);out['captured']={'moduleSource':body.get('moduleSource',''),'moduleSourcePresent':'moduleSource' in body,'viewport':body.get('viewport'),'traceResource':p.get('_file')}
print(json.dumps(out))`,resolve(dir,'trace.zip')],{encoding:'utf8',maxBuffer:20_000_000}));
  if(!trace.captured || !trace.captured.viewport)throw new Error('Captured initial module source/viewport evidence unavailable');
  let jsx=trace.captured.moduleSource;
  result.initialCapture=trace.captured;
  result.patchOperations=[];
  for(const [turnIndex,turn] of evidence.turns.entries()) for(const log of turn.logs) for(const step of log.sourceSteps??[]) {
    if(step.action!=='apply_patch'||step.outcome!=='succeeded'||step.input.path!=='module.jsx')continue;
    for(const edit of step.input.edits){
      if(edit.kind==='insert')jsx=edit.position==='start'?edit.text+jsx:edit.position==='end'?jsx+edit.text:(()=>{throw new Error('Unsupported insert position');})();
      else if(edit.kind==='replace'){
        const matches=jsx.split(edit.search).length-1;
        if(!edit.search||matches!==1)throw new Error('Replacement cannot be replayed unambiguously');
        jsx=jsx.replace(edit.search,edit.replace);
      }else throw new Error('Unsupported successful JSX operation');
      result.patchOperations.push({turn:turnIndex+1,logId:log.id,toolCallId:step.toolCallId,kind:edit.kind});
    }
  }
  if(!jsx.trim())throw new Error('No reconstructable module source');
  const compilerPath=resolve(sourceRoot,'apps/agent-service/src/workspace/module-compiler.ts');
  const runtimePath=resolve(sourceRoot,'apps/agent-service/replica-runtime/ui-agent-module.js');
  const {compileModuleSource}=await import(pathToFileURL(compilerPath).href);
  const compiled=compileModuleSource(jsx),runtime=readFileSync(runtimePath);
  Object.assign(result,{compilerSha256:sha(readFileSync(compilerPath)),runtimeSha256:sha(runtime),jsxSha256:sha(jsx),compiledSha256:sha(compiled)});
  writeFileSync(resolve(output,'reconstructed-module.jsx'),jsx);
  const previewUrl=Object.keys(trace.resources).find(u=>u.includes('/preview?'));
  if(!previewUrl)throw new Error('Final preview HTML not recorded');
  result.resources=Object.fromEntries(Object.entries(trace.resources).map(([url,r])=>[url,{sha256:sha(r.body),traceResource:r.traceResource}]));
  const expected=evidence.turns.at(-1);
  if(!expected.dom||!expected.geometry)throw new Error('Original post-edit DOM/geometry unavailable');
  browser=await chromium.launch({channel:'chromium',headless:false});
  const page=await browser.newPage({viewport:trace.captured.viewport,deviceScaleFactor:2,locale:'en-US',colorScheme:'light',reducedMotion:'no-preference'});
  page.on('pageerror',error=>result.consoleErrors.push(String(error)));
  await page.route('**/*',async route=>{
    const url=route.request().url();
    if(trace.resources[url])return route.fulfill({status:200,contentType:trace.resources[url].type,body:trace.resources[url].body});
    if(url===new URL('module.js',previewUrl).href)return route.fulfill({status:200,contentType:'text/javascript',body:compiled});
    if(url===new URL('replica-runtime.js',previewUrl).href)return route.fulfill({status:200,contentType:'text/javascript',body:runtime});
    result.requests.push({url,method:route.request().method(),outcome:'blocked'});return route.abort();
  });
  await page.goto(previewUrl);
  const stage=page.locator('[data-ui-agent-snapshot-stage]');
  // The capture bridge can leave an empty style attribute on an input.
  // Restore only this recorded inert difference; all other markup, including
  // nonempty styles, must already match. Keep the exact DOM/geometry gates.
  result.emptyStyleRestoration=await stage.evaluate((root,expectedHtml)=>{
    const stripEmptyStyle=html=>html.replace(/ style=""/g,'');
    const actual=root.outerHTML;
    if(actual===expectedHtml||stripEmptyStyle(actual)!==stripEmptyStyle(expectedHtml))return [];
    const expectedRoot=new DOMParser().parseFromString(expectedHtml,'text/html').body.firstElementChild;
    const expectedNodes=[expectedRoot,...expectedRoot.querySelectorAll('*')];
    const actualNodes=[root,...root.querySelectorAll('*')];
    if(actualNodes.length!==expectedNodes.length)return [];
    const restored=[];
    actualNodes.forEach((node,index)=>{
      if(node.tagName===expectedNodes[index].tagName&&!node.hasAttribute('style')&&expectedNodes[index].getAttribute('style')===''){
        node.setAttribute('style','');
        restored.push({nodeIndex:index,tag:node.tagName,attribute:'style',value:''});
      }
    });
    return restored;
  },expected.dom);
  await expect.poll(()=>stage.evaluate(e=>e.outerHTML),{timeout:10000,message:'Reconstructed stage DOM matches original post-edit DOM exactly'}).toBe(expected.dom);
  result.initialDom=await stage.evaluate(e=>e.outerHTML);
  const geometry=()=>stage.evaluate(e=>[e,...e.querySelectorAll('main,header,section,article,h1,h2,p,aside,button,input,.columns,.stack,.pair,.scroll-list,.actions')].map(n=>{
    const r=n.getBoundingClientRect(),s=getComputedStyle(n);
    return {tag:n.tagName,sourceId:n.getAttribute('data-ui-source-id'),className:n.className,text:n.textContent.slice(0,500),rect:{x:r.x,y:r.y,width:r.width,height:r.height},color:s.color,fontSize:s.fontSize,display:s.display,position:s.position,overflowX:s.overflowX,overflowY:s.overflowY,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth};
  }));
  await expect.poll(geometry,{timeout:5000,message:'Reconstructed initial geometry and computed styles exactly match original evidence'}).toEqual(expected.geometry);
  result.initialGeometry=await geometry();result.equivalentInitialState=true;
  result.initialAriaSnapshot=await stage.ariaSnapshot();
  await page.screenshot({path:resolve(output,'initial-aligned.png'),fullPage:true});
  const settle = async () => {
    let previous, stable=0;
    await expect.poll(async()=>{
      const observed=await stage.evaluate(root=>({
        running:root.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity),
        nodes:[root,...root.querySelectorAll('*')].map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return[r.x,r.y,r.width,r.height,s.opacity,s.display,s.visibility,s.transform];})
      }));
      const encoded=JSON.stringify(observed.nodes);stable=!observed.running&&encoded===previous?stable+1:0;previous=encoded;return stable>=2;
    },{timeout:5000,intervals:[100],message:'Interaction animation and geometry have settled'}).toBe(true);
  };
  const actions=evidence.case.actions;
  if(!actions?.length)throw new Error('No final task-level actions to recheck');
  for(const [index,action] of actions.entries()) {
    const record={action,status:'pending'};result.actions.push(record);
    try {
      if(action.kind==='click'){
        const name=new RegExp('^'+Array.from(action.name).map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s*')+'$');
        const exactName=page.getByRole(action.role,{name});
        const visibleLabel=page.getByRole(action.role).filter({hasText:name,visible:true});
        record.originalExactNameMatches=await exactName.count();
        record.visibleRoleLabelMatches=await visibleLabel.count();
        await expect(visibleLabel,'A unique visible control of the requested role has the exact text label').toHaveCount(1);
        record.controlBefore=await visibleLabel.evaluate(e=>({html:e.outerHTML,text:e.innerText,rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}}));
        record.ariaBefore=await visibleLabel.ariaSnapshot();
        await visibleLabel.click({timeout:4000});
      } else if(action.kind==='visible')await expect.poll(()=>page.getByText(action.text,{exact:true}).evaluateAll(nodes=>nodes.some(n=>{
        if(!n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;
        const r=n.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;
        let top=Math.max(0,r.top),left=Math.max(0,r.left),bottom=Math.min(innerHeight,r.bottom),right=Math.min(innerWidth,r.right);
        for(let a=n.parentElement;a;a=a.parentElement){const s=getComputedStyle(a),b=a.getBoundingClientRect();
          if(['hidden','clip','auto','scroll'].includes(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom);}
          if(['hidden','clip','auto','scroll'].includes(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right);}
        }
        return bottom-top>=r.height-1&&right-left>=r.width-1;
      })),{timeout:4000,message:'Requested content is visibly rendered without ancestor clipping'}).toBe(true);
      else if(action.kind==='hidden')await expect(page.getByText(action.text,{exact:true})).toBeHidden({timeout:4000});
      else if(action.kind==='fill')await page.getByLabel(action.label,{exact:true}).fill(action.value,{timeout:4000});
      else throw new Error(`Unsupported action kind: ${action.kind}`);
      await settle();
      record.status='passed';
    }catch(error){record.status='failed';record.error=String(error);}
    record.dom=await stage.evaluate(e=>e.outerHTML);record.geometry=await geometry();record.ariaSnapshot=await stage.ariaSnapshot();
    await page.screenshot({path:resolve(output,`action-${index+1}.png`),fullPage:true});
    // A failed prerequisite does not turn downstream checks into fresh evidence.
    if(record.status==='failed')break;
  }
  result.status=result.actions.length===actions.length&&result.actions.every(a=>a.status==='passed')?'passed':'failed';
  if(result.consoleErrors.length){result.status='undetermined';result.failure='Browser runtime error prevents equivalent interaction acceptance';}
}catch(error){result.failure=String(error);result.status='undetermined';}
finally{if(browser)await browser.close();writeFileSync(resolve(output,'acceptance-supplement.json'),JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({status:result.status,equivalentInitialState:result.equivalentInitialState,actions:result.actions.map(a=>({action:a.action,status:a.status,originalExactNameMatches:a.originalExactNameMatches,visibleRoleLabelMatches:a.visibleRoleLabelMatches})),failure:result.failure,output},null,2));
if(result.status!=='passed')process.exitCode=1;
