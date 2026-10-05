// Local, model-backed acceptance runner. Never imported by product code.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './real-cases.mjs';
import { complexCases } from './complex-cases.mjs';
import { demoCases } from './demo-cases.mjs';

const cwd = dirname(fileURLToPath(import.meta.url)), repo = resolve(cwd, '../..');
const turnTimeoutMs = 600000;
const plannedModels = ['default','qwen'], repeats = 2;
const scenarioPlan = [
  ['base','Q01'], ['base','E01'], ['base','M01'], ['base','L03'],
  ['complex','C01'], ['complex','C04'], ['complex','C11'], ['complex','C16'],
  ['demo','D00'], ['demo','D05'],
].map(([suite,id]) => ({suite, ...({base:cases,complex:complexCases,demo:demoCases}[suite].find(c => c.id === id))}));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path,'utf8'));
const save = (path,value) => { mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,JSON.stringify(value,null,2)+'\n'); };
const evaluatorFiles = ['optimization-benchmark.mjs','real.spec.mjs','real.config.mjs','real-service.mjs','harness.mjs','cdp.mjs','layouts.mjs','real-cases.mjs','complex-cases.mjs','demo-cases.mjs','wxt.config.ts'];
const evaluator = Object.fromEntries(evaluatorFiles.map(name => [name,hash(readFileSync(resolve(cwd,name)))]));
const protocol = {
  version:1, models:plannedModels, repeats, turnTimeoutMs,
  scenarios:scenarioPlan.map(({suite,...item})=>({suite,id:item.id,plannedTurns:item.turns.length,sha256:hash(JSON.stringify(item))})),
  evaluator,
  timing:'Sum of submitted prompt-to-terminal-UI durations, excluding fixture setup and post-result acceptance actions; shared 10 minute deadline per turn.',
  failure:'A submitted task fails if any automated check or semantic acceptance fails. Setup failures are reported separately and block a complete comparison. Pending semantic review is never success.',
  speed:'Matched-success task mean plus all-planned-task capped mean (a failed task costs its full planned turn budget); report both and all-task completion coverage.',
  stability:'Relative reduction of per-model task failure rate; a zero-failure baseline cannot prove a relative reduction.',
};
const slots = [];
for(let repeat=1;repeat<=repeats;repeat++) for(const [index,item] of scenarioPlan.entries()) {
  const order = (repeat+index)%2 ? plannedModels : [...plannedModels].reverse();
  for(const model of order) slots.push({key:`r${repeat}-${item.id}-${model}`,repeat,model,suite:item.suite,caseId:item.id,plannedTurns:item.turns.length});
}
const args = process.argv.slice(2), mode = args.shift();
function option(name,fallback) { const i=args.indexOf(name); if(i<0)return fallback; if(!args[i+1] || args[i+1].startsWith('--'))throw new Error(`Missing ${name} value`); const value=args[i+1];args.splice(i,2);return value; }
const output = resolve(option('--output-root',resolve(repo,'output/real-model/optimization/comparison')));
const models = option('--models',plannedModels.join(',')).split(',');
const repeatFilter = Number(option('--repeat','0'));
if(models.some(m=>!plannedModels.includes(m)) || ![0,1,2].includes(repeatFilter)) throw new Error('Models must be default,qwen; --repeat must be 1 or 2');
const usage = 'Usage: node tooling/e2e/optimization-benchmark.mjs run baseline|candidate [--output-root PATH] [--models default,qwen] [--repeat 1|2]\n       node ... compare [--output-root PATH]\n       node ... review baseline|candidate SLOT passed|failed|undetermined NOTE [--output-root PATH]';
if(!['run','compare','review'].includes(mode)) throw new Error(usage);
mkdirSync(output,{recursive:true});
const protocolPath=resolve(output,'protocol.json');
if(existsSync(protocolPath)) { if(JSON.stringify(json(protocolPath))!==JSON.stringify(protocol)) throw new Error('Frozen protocol/evaluator differs. Do not mix results: use a new output root and run both phases with the same evaluator.'); }
else save(protocolPath,protocol);
const phasePath=phase=>resolve(output,`${phase}.json`);
const validPhase=phase=>{if(!['baseline','candidate'].includes(phase))throw new Error(usage);return phase;};
function sourceFingerprint() {
  // Walk explicit product source roots: a frozen source copy need not have .git.
  const files=[];
  const walk=path=>{
    if(!existsSync(resolve(repo,path)))return;
    for(const entry of readdirSync(resolve(repo,path),{withFileTypes:true})) {
      if(entry.name.startsWith('.')||['node_modules','dist','output'].includes(entry.name))continue;
      const name=`${path}/${entry.name}`;
      if(entry.isDirectory())walk(name);
      else if(entry.isFile())files.push(name);
    }
  };
  for(const path of ['apps/agent-service/src','apps/extension/src','packages/agent-runtime','packages/contracts','packages/replica-component-runtime','apps/extension/entrypoints','apps/demo-page/src','apps/demo-page/public'])walk(path);
  if(existsSync(resolve(repo,'apps/extension/wxt.config.ts')))files.push('apps/extension/wxt.config.ts');
  return Object.fromEntries(files.sort().map(p=>[p,hash(readFileSync(resolve(repo,p)))]));
}
function evaluations(dir) {
  if(!existsSync(dir)) return [];
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?evaluations(resolve(dir,entry.name)):entry.name==='evaluation.json'?[resolve(dir,entry.name)]:[]);
}
function collect(slot,runDir,processResult) {
  const files=evaluations(resolve(runDir,'results'));
  if(files.length!==1) return {kind:'setup_failed',evaluationFiles:files,reason:'Missing or ambiguous evaluation record',process:processResult};
  const evidence=json(files[0]);
  const submitted=evidence.turns.filter(t=>t.status!=='prepared');
  return {kind:evidence.failureCategory==='setup'||!submitted.length?'setup_failed':evidence.automated==='passed'?'automated_passed':'automated_failed',
    evaluation:files[0],model:evidence.model,provenance:evidence.provenance,automated:evidence.automated,failure:evidence.failure,
    elapsedMs:submitted.reduce((sum,t)=>sum+(t.elapsedMs??0),0),submittedTurns:submitted.length,completedTurns:submitted.filter(t=>t.status==='completed').length,
    timedOutTurns:submitted.filter(t=>t.status==='timed_out').length,plannedTurns:slot.plannedTurns,
    turns:submitted.map(t=>({prompt:t.prompt,status:t.status,elapsedMs:t.elapsedMs,checksPassed:t.checksPassed,logs:t.logs.map(l=>({model:l.model,result:l.result,durationMs:l.durationMs,toolStatistics:l.toolStatistics,modelCalls:l.codingAgent?.checkpoint?.modelCalls})),routes:t.routes})),
    semanticReview:{status:'pending',note:''},process:processResult};
}
if(mode==='run') {
  const phase=validPhase(args.shift());if(args.length)throw new Error(usage);
  const fingerprints=sourceFingerprint();
  let manifest=existsSync(phasePath(phase))?json(phasePath(phase)):{phase,createdAt:new Date().toISOString(),sourceRoot:repo,sourceFingerprint:fingerprints,slots:slots.map(slot=>({...slot,status:'planned'}))};
  if(JSON.stringify(manifest.sourceFingerprint)!==JSON.stringify(fingerprints)) throw new Error('Product source changed within this phase. Keep the baseline snapshot immutable; start a new candidate phase in another output root for a new candidate.');
  save(phasePath(phase),manifest);
  let errors=false;
  for(const slot of manifest.slots.filter(s=>models.includes(s.model)&&(!repeatFilter||s.repeat===repeatFilter))) {
    if(slot.status==='finished')continue;
    if(slot.status==='running')throw new Error(`Slot ${slot.key} has an unresolved prior process. Inspect its recorded PID and evidence; this runner will not silently restart it.`);
    const runId=`${phase}-${slot.key}`;
    if(existsSync(resolve(output,'runs',runId)))throw new Error(`Evidence already exists for ${runId}; refusing to overwrite or implicitly retry it. Preserve this attempt and use an explicitly separate run for setup diagnosis.`);
    slot.status='running';slot.startedAt=new Date().toISOString();slot.runId=runId;slot.runnerPid=process.pid;
    save(phasePath(phase),manifest);
    console.log(`\n[${phase}] ${slot.key}: ${slot.plannedTurns} planned turns; no automatic retry`);
    const launched=Date.now();
    const result=spawnSync(process.execPath,[resolve(cwd,'node_modules/@playwright/test/cli.js'),'test','--config','real.config.mjs'],{
      cwd,stdio:'inherit',env:{...process.env,REAL_SUITE:slot.suite,REAL_CASES:slot.caseId,REAL_MODEL_ID:slot.model,REAL_RUN_ID:runId,REAL_OUTPUT_ROOT:resolve(output,'runs'),REAL_TURN_TIMEOUT_MS:String(turnTimeoutMs)}
    });
    slot.status='finished';slot.finishedAt=new Date().toISOString();slot.wallMs=Date.now()-launched;
    slot.result=collect(slot,resolve(output,'runs',runId),{exitCode:result.status,signal:result.signal,error:result.error?.message});
    if(result.status!==0 && slot.result.kind==='automated_passed')slot.result.kind='infrastructure_failed';
    errors ||= result.status!==0 || slot.result.kind!=='automated_passed';
    save(phasePath(phase),manifest);
    if(result.signal || result.error) break;
  }
  console.log(`Phase evidence: ${phasePath(phase)}. Semantic reviews remain required.`);
  process.exitCode=errors?1:0;
}
if(mode==='review') {
  const phase=validPhase(args.shift()), key=args.shift(), status=args.shift(), note=args.join(' ').trim();
  if(!['passed','failed','undetermined'].includes(status)||!note)throw new Error(usage);
  const manifest=json(phasePath(phase)), slot=manifest.slots.find(s=>s.key===key);
  if(!slot?.result?.evaluation || !['automated_passed','automated_failed'].includes(slot.result.kind))throw new Error('Review needs an executed task with evaluation evidence');
  slot.result.semanticReview={status,note,reviewedAt:new Date().toISOString()};
  save(phasePath(phase),manifest);
  console.log(`Recorded ${phase}/${key}: ${status}`);
}
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]:null;
const outcome=slot=>slot?.status!=='finished'?'missing':!['automated_passed','automated_failed'].includes(slot.result?.kind)?'setup_failed':slot.result.automated==='failed'||slot.result.semanticReview.status==='failed'?'failed':slot.result.semanticReview.status!=='passed'?'unreviewed':'passed';
function summarize(phase,model) {
  const planned=phase?.slots.filter(s=>s.model===model)??slots.filter(s=>s.model===model), counts={passed:0,failed:0,unreviewed:0,setup_failed:0,missing:0};
  for(const slot of planned)counts[outcome(slot)]++;
  const completed=counts.passed+counts.failed;
  const executed=planned.filter(s=>['automated_passed','automated_failed'].includes(s.result?.kind));
  const pendingReview=executed.filter(s=>!['passed','failed'].includes(s.result.semanticReview.status)).length;
  return {planned:planned.length,...counts,resolvedOutcomes:completed,pendingReview,reviewedTasks:executed.length-pendingReview,
    knownFailureRate:executed.length?counts.failed/executed.length:null,
    failureRate:completed&&counts.unreviewed===0?counts.failed/completed:null,
    complete:completed===planned.length&&pendingReview===0,
    matchedEligible:planned.filter(s=>outcome(s)==='passed').map(s=>s.key),
    successMeanMs:mean(planned.filter(s=>outcome(s)==='passed').map(s=>s.result.elapsedMs)),
    successP90Ms:percentile(planned.filter(s=>outcome(s)==='passed').map(s=>s.result.elapsedMs),.9),
    failureElapsedMs:planned.filter(s=>outcome(s)==='failed').map(s=>({key:s.key,elapsedMs:s.result.elapsedMs,submittedTurns:s.result.submittedTurns,plannedTurns:s.plannedTurns})),
    cappedAllTaskMeanMs:completed===planned.length?mean(planned.map(s=>outcome(s)==='passed'?s.result.elapsedMs:s.plannedTurns*turnTimeoutMs)):null};
}
if(mode==='compare') {
  if(args.length)throw new Error(usage);
  const baseline=existsSync(phasePath('baseline'))?json(phasePath('baseline')):undefined;
  const candidate=existsSync(phasePath('candidate'))?json(phasePath('candidate')):undefined;
  const report={generatedAt:new Date().toISOString(),protocolSha256:hash(JSON.stringify(protocol)),verified:false,models:[]};
  for(const model of plannedModels) {
    const before=summarize(baseline,model),after=summarize(candidate,model),pairs=[];
    const mismatches=[],qualityRegressions=[];
    for(const slot of slots.filter(s=>s.model===model)) {
      const a=baseline?.slots.find(s=>s.key===slot.key),b=candidate?.slots.find(s=>s.key===slot.key);
      const modelIdentity=r=>r&&({name:r.name,provider:r.provider,baseUrl:r.baseUrl,apiProtocol:r.apiProtocol,enableThinking:r.enableThinking,edit:r.edit,router:r.router});
      if(a?.result?.model&&b?.result?.model&&JSON.stringify(modelIdentity(a.result.model))!==JSON.stringify(modelIdentity(b.result.model)))mismatches.push(`${slot.key}: model identity`);
      for(const key of ['caseSha256','fixtureSha256','assetSha256'])if(a?.result?.provenance&&b?.result?.provenance&&JSON.stringify(a.result.provenance[key])!==JSON.stringify(b.result.provenance[key]))mismatches.push(`${slot.key}: ${key}`);
      if(outcome(a)==='passed'&&outcome(b)==='passed')pairs.push({key:slot.key,beforeMs:a.result.elapsedMs,afterMs:b.result.elapsedMs});
      if(a?.result?.semanticReview?.status==='passed'&&b?.result?.semanticReview?.status==='failed')qualityRegressions.push(slot.key);
    }
    const baselineMean=mean(pairs.map(p=>p.beforeMs)),candidateMean=mean(pairs.map(p=>p.afterMs));
    const speedReduction=baselineMean>0?1-candidateMean/baselineMean:null;
    const cappedReduction=before.cappedAllTaskMeanMs>0&&after.cappedAllTaskMeanMs!==null?1-after.cappedAllTaskMeanMs/before.cappedAllTaskMeanMs:null;
    const failureReduction=before.failureRate>0&&after.failureRate!==null?1-after.failureRate/before.failureRate:null;
    const complete=before.complete&&after.complete&&!mismatches.length;
    const verified=complete&&speedReduction>=.2&&cappedReduction>=.2&&failureReduction>=.2&&!qualityRegressions.length;
    report.models.push({configuredModel:model,before,after,matchedSuccess:{count:pairs.length,baselineMeanMs:baselineMean,candidateMeanMs:candidateMean,speedReduction,pairs},cappedReduction,failureReduction,mismatches,qualityRegressions,verified,
      notes:[!complete?'Missing/unreviewed/setup-failed tasks or mismatched provenance prevent acceptance.':null,before.failureRate===0?'Zero failures in baseline: relative failure reduction is undefined and not proven.':null,qualityRegressions.length?'Some baseline semantic passes became candidate semantic failures.':null].filter(Boolean)});
  }
  report.verified=report.models.every(m=>m.verified);
  save(resolve(output,'comparison.json'),report);
  const pct=n=>n===null?'未证实':`${(n*100).toFixed(1)}%`;
  const lines=['# Agent 优化前后对比','',`目标完成：${report.verified?'已验证':'未验证'}`,'','所有任务及重复均预先冻结；超时和失败保留，未审核不计成功，环境准备失败使验收不完整。','',
    '| 模型配置 | 基线成功/失败/待核对 | 候选成功/失败/待核对 | 匹配成功任务数 | 匹配耗时降低 | 全计划惩罚耗时降低 | 失败率相对降低 |','| --- | --- | --- | --- | --- | --- | --- |'];
  for(const m of report.models){const counts=s=>`${s.passed}/${s.failed}/${Math.max(s.unreviewed,s.pendingReview)+s.setup_failed+s.missing}`;lines.push(`| ${m.configuredModel} | ${counts(m.before)} | ${counts(m.after)} | ${m.matchedSuccess.count} | ${pct(m.matchedSuccess.speedReduction)} | ${pct(m.cappedReduction)} | ${pct(m.failureReduction)} |`);}
  for(const m of report.models)for(const note of m.notes)lines.push('',`${m.configuredModel}: ${note}`);
  lines.push('','全计划惩罚耗时：成功任务采用实际对话耗时；失败任务按该任务所有计划轮次的 10 分钟上限赋予惩罚耗时，避免早失败和漏执行轮次被误算为提速。匹配成功耗时只用于前后均成功的同一个重复任务，必须同时检查全计划覆盖、质量和失败率。','', '待核对包含失败任务尚未完成的语义审核，因此不与成功/失败互斥。两个重复是首轮工程验证，不能当成生产分布的统计置信结论。');
  writeFileSync(resolve(output,'comparison.md'),lines.join('\n')+'\n');
  console.log(`Comparison: ${resolve(output,'comparison.md')}`);process.exitCode=report.verified?0:1;
}
