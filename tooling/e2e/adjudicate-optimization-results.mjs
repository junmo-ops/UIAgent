// Derive an audited acceptance view without mutating frozen runs or metrics.
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2),notes=[],corrections=[];
let sourceRoot,outputRoot;
const usage='Usage: node tooling/e2e/adjudicate-optimization-results.mjs --source-root RAW_ROOT --output-root NEW_DERIVED_ROOT [--notes PHASE=NOTES_JSON ...] [--correction PHASE:SLOT=SUPPLEMENT_JSON ...]';
for(let i=0;i<args.length;i+=2){const value=args[i+1];if(!value)throw new Error(usage);
  if(args[i]==='--source-root')sourceRoot=resolve(value);
  else if(args[i]==='--output-root')outputRoot=resolve(value);
  else if(args[i]==='--notes')notes.push(value);
  else if(args[i]==='--correction')corrections.push(value);
  else throw new Error(usage);
}
if(!sourceRoot||!outputRoot)throw new Error(usage);
sourceRoot=realpathSync(sourceRoot);
if(outputRoot===sourceRoot||outputRoot.startsWith(sourceRoot+'/')||existsSync(outputRoot))throw new Error('Use a new derived output directory outside the raw result directory; existing evidence is never overwritten');
const sha=value=>createHash('sha256').update(value).digest('hex');
const load=path=>{path=realpathSync(path);const bytes=readFileSync(path);return{path,sha256:sha(bytes),data:JSON.parse(bytes),bytes};};
const requireFact=(condition,message)=>{if(!condition)throw new Error(message);};
const mapping=(raw,withSlot)=>{const index=raw.indexOf('=');requireFact(index>0,'Explicit phase/path mapping required');const identity=raw.slice(0,index),[phase,slot]=identity.split(':');requireFact(['baseline','candidate'].includes(phase)&&(!withSlot||slot),'Invalid phase/slot mapping');return{phase,slot,path:resolve(raw.slice(index+1))};};
const protocol=load(resolve(sourceRoot,'protocol.json'));
const phases=Object.fromEntries(['baseline','candidate'].filter(phase=>existsSync(resolve(sourceRoot,`${phase}.json`))).map(phase=>[phase,load(resolve(sourceRoot,`${phase}.json`))]));
const reviewMethod='agent-semantic-and-visual-review';
const audit={kind:'adjudicated-optimization-view',reviewMethod,userAcceptance:'not-recorded',createdAt:new Date().toISOString(),rawRoot:sourceRoot,derivedRoot:outputRoot,scriptSha256:sha(readFileSync(new URL(import.meta.url))),rawProtocolSha256:protocol.sha256,
  rule:'Only documented semantic/visual review plus zero-model-call, exactly aligned recorded-interaction recheck can correct an isolated interaction locator failure. Original model outputs, timing and raw files remain unchanged.',
  sourceSnapshots:Object.fromEntries(Object.entries(phases).map(([phase,value])=>[phase,{path:value.path,sha256:value.sha256,snapshotPath:resolve(outputRoot,'source-snapshots',`${phase}.json`)}])),noteFiles:[],semanticMerges:[],corrections:[]};
const reviews=new Map();
const reviewSnapshots=new Map();
function reviewPathMatches(note,path){
  if(typeof note.evidence==='string')return resolve(note.evidence)===path;
  if(Array.isArray(note.evidence))return note.evidence.some(item=>item.path&&resolve(item.path)===path);
  return Boolean(note.evidence?.evaluation&&resolve(note.evidence.evaluation)===path);
}
for(const raw of notes){const mappingValue=mapping(raw,false),input=load(mappingValue.path),snapshotPath=resolve(outputRoot,'review-snapshots',`${input.sha256}.json`);
  reviewSnapshots.set(snapshotPath,input.bytes);
  audit.noteFiles.push({phase:mappingValue.phase,path:input.path,sha256:input.sha256,snapshotPath});
  const rows=input.data.reviews??[input.data];requireFact(Array.isArray(rows),'Expected reviews array or one review object');
  for(const row of rows){const phase=row.phase??mappingValue.phase;requireFact(phase===mappingValue.phase,'Note phase conflicts with explicit CLI phase');
    requireFact(typeof row.slot==='string'&&['passed','failed','pending','undetermined'].includes(row.status)&&typeof row.note==='string'&&row.note.trim(),`Invalid review in ${input.path}`);
    const slot=phases[phase]?.data.slots.find(s=>s.key===row.slot);requireFact(slot?.status==='finished'&&slot.result?.evaluation,`Review is not for a completed recorded task: ${phase}:${row.slot}`);
    const evidence=load(slot.result.evaluation);
    if(row.evidenceSha256)requireFact(row.evidenceSha256===evidence.sha256,`Stale evidence hash: ${phase}:${row.slot}`);
    // Supplement-based reviews are bound to the original file by correction
    // validation below; ordinary notes must explicitly identify its path.
    requireFact(reviewPathMatches(row,evidence.path)||Boolean(row.supplement&&row.supplementSha256),`Review does not identify its evidence: ${phase}:${row.slot}`);
    const key=`${phase}:${row.slot}`,old=reviews.get(key),resolved=status=>['passed','failed'].includes(status);
    requireFact(!old||!resolved(old.row.status)||!resolved(row.status)||old.row.status===row.status,`Conflicting documented semantic/visual reviews: ${key}`);
    if(old&&resolved(old.row.status)&&!resolved(row.status))continue;
    reviews.set(key,{row,input:{path:input.path,sha256:input.sha256,snapshotPath},evidence,phase,slot});
  }
}
const corrected=new Set();
for(const raw of corrections){const {phase,slot:key,path}=mapping(raw,true),identity=`${phase}:${key}`;requireFact(!corrected.has(identity),`Duplicate correction: ${identity}`);
  const review=reviews.get(identity);requireFact(review?.row.status==='passed',`Correction requires documented semantic/visual review: ${identity}`);
  const {slot,evidence}=review,supplement=load(path),s=supplement.data,e=evidence.data,r=slot.result;
  requireFact(resolve(review.row.supplement??'')===supplement.path&&review.row.supplementSha256===supplement.sha256,'Documented semantic/visual review does not bind this supplement hash');
  requireFact(r.kind==='automated_failed'&&r.automated==='failed'&&e.automated==='failed','Only original automated task failures can be corrected');
  requireFact(e.failure==='Error: One or more browser interaction checks failed; see evaluation.json','Original failure includes a non-interaction acceptance failure');
  requireFact(e.turns.length===e.case.turns.length&&e.turns.every(t=>t.status==='completed'&&t.checksPassed===true),'All planned turns must complete their original non-final-interaction checks');
  requireFact(e.turns.every(t=>t.routes.every(x=>x.result.kind!=='failed')&&t.logs.every(l=>!['failed','cancelled'].includes(l.result?.kind))),'A model/task failure cannot be corrected by interaction recheck');
  const originalActions=e.interactions??[],expectedActions=e.case.actions??[];
  requireFact(expectedActions.length>0&&originalActions.length===expectedActions.length&&originalActions.every((a,i)=>equal(a.action,expectedActions[i])),'Incomplete original interaction chain');
  const firstFailure=originalActions.findIndex(a=>a.outcome==='failed');
  requireFact(firstFailure>=0&&originalActions[firstFailure].action.kind==='click'&&/locator\.click/.test(originalActions[firstFailure].error??'')&&/getByRole/.test(originalActions[firstFailure].error??''),'First failure must be a role-based click locator failure');
  requireFact(originalActions.slice(0,firstFailure).every(a=>a.outcome==='passed'),'Earlier interaction prerequisite did not pass');
  requireFact(s.kind==='eval-only-recorded-interaction-recheck'&&s.status==='passed'&&s.modelCalls===0&&s.equivalentInitialState===true,'Supplement did not prove zero-model-call equivalent-state acceptance');
  requireFact(realpathSync(s.evidencePath)===evidence.path&&s.evidenceSha256===evidence.sha256,'Supplement is stale or belongs to another original result');
  requireFact(s.traceSha256===sha(readFileSync(resolve(dirname(evidence.path),'trace.zip'))),'Supplement trace hash differs');
  requireFact(s.caseId===e.case.id&&s.sourceRoot===phases[phase].data.sourceRoot,'Supplement case or frozen source root differs');
  requireFact(s.compilerSha256===phases[phase].data.sourceFingerprint['apps/agent-service/src/workspace/module-compiler.ts'],'Supplement compiler is not from the phase source fingerprint');
  requireFact(s.runtimeSha256===sha(readFileSync(resolve(s.sourceRoot,'apps/agent-service/replica-runtime/ui-agent-module.js'))),'Frozen runtime artifact no longer matches supplement');
  requireFact(s.initialDom===e.turns.at(-1).dom&&equal(s.initialGeometry,e.turns.at(-1).geometry),'Initial DOM/geometry are not exactly equivalent');
  requireFact(Array.isArray(s.consoleErrors)&&s.consoleErrors.length===0&&Array.isArray(s.requests)&&s.requests.length===0,'Replay has browser errors or incomplete recorded resources');
  requireFact(s.actions.length===expectedActions.length&&s.actions.every((a,i)=>a.status==='passed'&&equal(a.action,expectedActions[i])),'Supplement did not pass every planned action');
  requireFact(s.actions[firstFailure].originalExactNameMatches===0&&s.actions[firstFailure].visibleRoleLabelMatches===1,'Supplement did not demonstrate an original-name locator mismatch with a unique visible control');
  const protectedBefore=JSON.stringify({elapsedMs:r.elapsedMs,model:r.model,provenance:r.provenance,turns:r.turns,process:r.process,submittedTurns:r.submittedTurns,completedTurns:r.completedTurns,timedOutTurns:r.timedOutTurns,plannedTurns:r.plannedTurns});
  const entry={phase,slot:key,rawResultPath:evidence.path,rawEvidenceSha256:evidence.sha256,rawAutomated:r.automated,rawFailure:r.failure,rawKind:r.kind,supplementPath:supplement.path,supplementSha256:supplement.sha256,method:s.method,semanticReview:{...review.input,reviewMethod},reason:review.row.note};
  Object.assign(r,{rawAutomated:r.automated,rawFailure:r.failure,rawKind:r.kind,rawResultPath:evidence.path,kind:'automated_passed',automated:'passed',acceptanceCorrection:entry});
  delete r.failure;
  requireFact(protectedBefore===JSON.stringify({elapsedMs:r.elapsedMs,model:r.model,provenance:r.provenance,turns:r.turns,process:r.process,submittedTurns:r.submittedTurns,completedTurns:r.completedTurns,timedOutTurns:r.timedOutTurns,plannedTurns:r.plannedTurns}),'Correction changed protected timing/model evidence');
  audit.corrections.push(entry);corrected.add(identity);
}
for(const [identity,review]of reviews){
  if(review.row.supplement)requireFact(corrected.has(identity),'A supplement-based review requires an explicit validated --correction mapping');
  const r=review.slot.result;
  r.semanticReview={reviewMethod,status:review.row.status,note:review.row.note,reviewedAt:review.row.reviewedAt??review.input.reviewedAt,adjudicatedFrom:review.input,evidenceSha256:review.evidence.sha256};
  audit.semanticMerges.push({reviewMethod,phase:review.phase,slot:review.slot.key,status:review.row.status,notePath:review.input.path,noteSha256:review.input.sha256,evidencePath:review.evidence.path,evidenceSha256:review.evidence.sha256});
}
mkdirSync(outputRoot,{recursive:false});
mkdirSync(resolve(outputRoot,'source-snapshots'));
mkdirSync(resolve(outputRoot,'review-snapshots'));
for(const [snapshotPath,bytes]of reviewSnapshots)writeFileSync(snapshotPath,bytes,{flag:'wx'});
writeFileSync(resolve(outputRoot,'protocol.json'),protocol.bytes);
for(const [phase,value]of Object.entries(phases)){
  const rawPhaseSnapshotPath=audit.sourceSnapshots[phase].snapshotPath;
  writeFileSync(rawPhaseSnapshotPath,value.bytes,{flag:'wx'});
  value.data.adjudication={derived:true,rawPhasePath:value.path,rawPhaseSha256:value.sha256,rawPhaseSnapshotPath,auditPath:resolve(outputRoot,'adjudication-audit.json')};
  writeFileSync(resolve(outputRoot,`${phase}.json`),JSON.stringify(value.data,null,2)+'\n');
}
writeFileSync(resolve(outputRoot,'adjudication-audit.json'),JSON.stringify(audit,null,2)+'\n');
const compare=spawnSync(process.execPath,[resolve(dirname(fileURLToPath(import.meta.url)),'optimization-benchmark.mjs'),'compare','--output-root',outputRoot],{stdio:'inherit'});
requireFact(!compare.error&&[0,1].includes(compare.status)&&existsSync(resolve(outputRoot,'comparison.json')),'Frozen comparison command could not create the derived report');
const report=load(resolve(outputRoot,'comparison.json')).data;
report.adjudicated=true;report.adjudication={reviewMethod,userAcceptance:'not-recorded',rawRoot:sourceRoot,auditPath:resolve(outputRoot,'adjudication-audit.json'),correctedTasks:audit.corrections.map(c=>({phase:c.phase,slot:c.slot,rawResultPath:c.rawResultPath,supplementPath:c.supplementPath})),semanticReviewCount:audit.semanticMerges.length};
writeFileSync(resolve(outputRoot,'comparison.json'),JSON.stringify(report,null,2)+'\n');
const auditLines=['# 有痕复核后的派生对比（adjudicated）','',`原始证据目录：${sourceRoot}。原始阶段文件及 evaluation 未修改。`, `复核审计：[adjudication-audit.json](${resolve(outputRoot,'adjudication-audit.json')})。Agent 语义与视觉复核 ${audit.semanticMerges.length} 项，自动验收纠错 ${audit.corrections.length} 项。`,''];
for(const c of audit.corrections)auditLines.push(`- ${c.phase}/${c.slot}：原始 ${c.rawAutomated} 保留；派生验收通过。补验：[记录](${c.supplementPath})。`);
auditLines.push('','纠错只修正有证据证明的交互定位误报，不改变耗时、模型结果和原始自动结果；未审核、缺失和其他失败保留。本报告记录 Agent 语义与视觉复核，用户真实场景验收尚未记录，二者分开。','');
writeFileSync(resolve(outputRoot,'comparison.md'),auditLines.join('\n')+readFileSync(resolve(outputRoot,'comparison.md'),'utf8'));
console.log(JSON.stringify({outputRoot,adjudicated:true,correctedTasks:audit.corrections.length,semanticReviews:audit.semanticMerges.length,verified:report.verified,models:report.models.map(m=>({model:m.configuredModel,before:m.before,after:m.after,verified:m.verified}))},null,2));
