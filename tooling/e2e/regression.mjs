import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const cwd = fileURLToPath(new URL('.', import.meta.url));
const [mode = 'smoke', ...models] = process.argv.slice(2);
if (!['smoke','core','compare'].includes(mode) || models.some(id => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))) {
  throw new Error('Usage: node regression.mjs smoke|core|compare [model-id ...]');
}
const ids = models.length ? [...new Set(models)] : mode === 'compare' ? ['default','qwen'] : ['default'];
const batch = new Date().toISOString().replace(/[:.]/g,'-');
const output = resolve(cwd, '../../output/real-model/regressions', batch);
mkdirSync(output,{recursive:true});
const report = {batch, mode, note:'各模型从独立新副本开始，一次样本不作为模型排名。指定模型映射为隔离服务默认选项，不覆盖菜单切换。', runs:[]};
let failed = false;
for (const id of ids) {
  const runId = `${batch}-${mode}-${id}`;
  const result = spawnSync(process.execPath, [resolve(cwd,'node_modules/@playwright/test/cli.js'),'test','--config','real.config.mjs'], {
    cwd, stdio:'inherit', env:{...process.env,REAL_SUITE:'demo',REAL_CASES:mode==='core'?'D04,D05,D06':'D00',REAL_MODEL_ID:id,REAL_RUN_ID:runId}
  });
  const dir = resolve(cwd,'../../output/real-model/runs',runId,'results');
  const run = {configuredId:id,runId,exitCode:result.status,signal:result.signal,cases:[]};
  for (const name of existsSync(dir)?readdirSync(dir):[]) {
    const file = resolve(dir,name,'evaluation.json'); if (!existsSync(file)) continue;
    const data = JSON.parse(readFileSync(file,'utf8'));
    run.cases.push({id:data.case.id,result:data.automated,failure:data.failure,model:data.model,provenance:data.provenance,
      turns:data.turns.map(t => ({elapsedMs:t.elapsedMs,beforeRevision:t.beforeRevision,afterRevision:t.afterRevision,
        checks:t.automatedChecks,editor:t.logs.map(l => ({durationMs:l.durationMs,model:l.model,result:l.result,tools:l.toolStatistics,
          modelCalls:l.codingAgent?.checkpoint?.modelCalls}))}))});
  }
  run.incomplete = run.cases.length !== (mode==='core'?3:1);
  failed ||= result.status !== 0 || run.incomplete || run.cases.some(c => c.result!=='passed');
  report.runs.push(run);
  writeFileSync(resolve(output,'summary.json'),JSON.stringify(report,null,2)+'\n');
  if (result.signal) break;
}
const lines = ['# 回归结果','',`批次：${batch}；类型：${mode}`,'',report.note,'',
 '| 配置 ID | 实际模型 | 用例 | 自动结果 | 对话耗时 | 编辑阶段耗时 |','| --- | --- | --- | --- | --- | --- |'];
for(const run of report.runs) {
 if(!run.cases.length) lines.push(`| ${run.configuredId} | — | — | 启动失败/无结果 | — | — |`);
 for(const c of run.cases) lines.push(`| ${run.configuredId} | ${c.model.name} | ${c.id} | ${c.result} | ${c.turns.map(t=>(t.elapsedMs/1000).toFixed(2)).join(' / ')}s | ${c.turns.flatMap(t=>t.editor.map(e=>(e.durationMs/1000).toFixed(2))).join(' / ')}s |`);
}
for (const run of report.runs) lines.push('',`[${run.configuredId} 原始证据](../../runs/${run.runId}/)`,'');
writeFileSync(resolve(output,'summary.md'),lines.join('\n')+'\n');
console.log(`Summary: ${output}/summary.md`);
process.exitCode = failed ? 1 : 0;
