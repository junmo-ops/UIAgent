// Read-only inventory. Never sends page contents or credentials to a model.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const require = createRequire(new URL('../../apps/agent-service/package.json', import.meta.url));
const { parseHTML } = require('linkedom');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = resolve(repo, 'apps/agent-service/.snapshots/source-workspaces');
const output = resolve(repo, 'output/real-model/local-assets/inventory.json');
const assets = [];
for (const entry of readdirSync(root, { withFileTypes: true })) {
 if (!entry.isDirectory()) continue;
 const dir = resolve(root, entry.name);
 const metaPath = resolve(dir, 'workspace.json');
 if (!existsSync(metaPath)) continue;
 const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
 const baseline = existsSync(resolve(dir, 'revisions/000/index.html')) ? resolve(dir, 'revisions/000') : dir;
 const html = readFileSync(resolve(baseline, 'index.html'), 'utf8');
 const { document } = parseHTML(html);
 const count = selector => document.querySelectorAll(selector).length;
 let host;
 try { host = new URL(meta.sourceUrl).hostname; } catch { host = 'unknown'; }
 const css = ['snapshot.css', 'author.css', 'author-overrides.css'].filter(name => existsSync(resolve(baseline, name))).map(name => readFileSync(resolve(baseline, name), 'utf8')).join('\n');
 assets.push({ workspaceId: entry.name, title: meta.title, host,
   baseline: baseline === dir ? 'current-only' : 'revision-000',
   htmlSha256: createHash('sha256').update(html).digest('hex'), bytes: Buffer.byteLength(html),
   nodes: count('*'), tables:count('table,[role="table"],[role="grid"]'),
   rows:count('tr,[role="row"]'), fields:count('input,select,textarea,[role="combobox"]'),
   dialogs:count('dialog,[role="dialog"]'),
   scrollDeclarations:(css.match(/overflow(?:-x|-y)?\s*:\s*(?:auto|scroll)/gi)||[]).length,
   externalReferenceCount:(html.match(/https?:\/\//g)||[]).length,
   readiness:'unreviewed; DOM counts do not establish visibility, sanitization or authorization',
   coverage:'existing replica editing only; not original capture fidelity' });
}
mkdirSync(resolve(output, '..'), { recursive:true });
writeFileSync(output, JSON.stringify({ generatedAt:new Date().toISOString(), networkUsed:false, assets }, null, 2));
console.log(JSON.stringify({ output, count:assets.length, uniqueHtml:new Set(assets.map(a=>a.htmlSha256)).size }));
