// Real-model replay of a recorded coding turn in an isolated copy.
// No writes to the user's workspace and no automatic retries.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { SourceWorkspaceStore } from '../../apps/agent-service/src/workspace/store.ts';
import { SkillRegistry } from '../../apps/agent-service/src/skills/registry.ts';
import { readServiceConfig } from '../../apps/agent-service/src/configuration/service-config.ts';
import { createModelRegistry } from '../../apps/agent-service/src/configuration/model-registry.ts';
import { editModePolicy } from '../../packages/agent-runtime/src/adapters/edit-mode-policy.ts';
import { readReasoningPolicy } from './reasoning-policy.mjs';

const [workspacePath, logPath, outputPath, policyOrEffort] = process.argv.slice(2);
if (!workspacePath || !logPath || !outputPath) {
  throw new Error('Usage: replay-workspace-turn.mjs WORKSPACE LOG OUTPUT [none|low|high|max|POLICY.json]');
}
const effort = ['none', 'low', 'high', 'max'].includes(policyOrEffort) ? policyOrEffort : undefined;
const policy = effort
  ? Object.fromEntries(['discovery', 'planning', 'execution', 'verification', 'correction', 'layoutExecution'].map(stage => [stage, effort]))
  : policyOrEffort ? readReasoningPolicy(policyOrEffort) : undefined;
const log = JSON.parse(readFileSync(logPath, 'utf8'));
const editMode = log.request.editMode ?? 'fast';
if (!['fast', 'normal', 'pro'].includes(editMode)) throw new Error('Invalid recorded edit mode');
// Production overrides only apply to Fast. Never silently switch a recorded
// Normal/Pro turn to Fast (which would also change its review/read budgets).
if (policy && editMode !== 'fast') throw new Error('Reasoning overrides only apply to Fast; omit the override to replay the recorded Normal/Pro policy');
const config = readServiceConfig();
const modelId = log.request.modelId ?? 'default';
const definition = modelId === 'default' ? config.model
  : config.model.alternatives?.find(item => item.id === modelId);
if (!definition || definition.name !== log.model.name) throw new Error('Replay model must match recorded model');
if (policy) definition.editReasoning = policy;
const registry = createModelRegistry(config, process.env, new SkillRegistry(), {});
// Use the same provider mapping, protocol and credential handling as the service.
const coding = registry.get(modelId).coding;
const effectivePolicy = editModePolicy(editMode, definition.editReasoning);
const beforeRevision = log.result?.revision - 1;
if (!Number.isSafeInteger(beforeRevision) || beforeRevision < 0) throw new Error('Recorded successful revision required');
const output = resolve(outputPath);
mkdirSync(output, { recursive: false });
const workspaceId = basename(resolve(workspacePath));
const root = resolve(output, 'workspaces');
const copy = resolve(root, workspaceId);
cpSync(resolve(workspacePath), copy, { recursive: true });
const store = new SourceWorkspaceStore(root, { identityIsolation: false });
// Restore the exact pre-turn revision in the isolated copy.
while (store.get(workspaceId).revision > beforeRevision) store.undo(workspaceId);
if (store.get(workspaceId).revision !== beforeRevision) throw new Error('Pre-turn revision unavailable');
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { kind: 'recorded-workspace-real-model-replay', status: 'running',
  recordedLogId: log.id, referenceDurationMs: log.durationMs, beforeRevision,
  model: { ...registry.metadata(modelId), configuredId: modelId, baseUrl: definition.baseUrl,
    apiProtocol: definition.apiProtocol ?? 'chat-completions', reasoningEffort: definition.reasoningEffort },
  editMode, reasoningOverride: policy, effectivePolicy,
  logSha256: hash(readFileSync(logPath)),
  beforeFiles: Object.fromEntries(['index.html', 'author-overrides.css', 'module.jsx'].map(name => [name, hash(readFileSync(resolve(copy, name)))])),
  runtimeSha256: hash(readFileSync(new URL('../../packages/agent-runtime/vendor/ui-agent-runtime/index.js', import.meta.url))),
  adapterSha256: hash(readFileSync(new URL('../../packages/agent-runtime/src/adapters/cline-coding-agent-adapter.ts', import.meta.url))),
  sourceReviewSha256: hash(readFileSync(new URL('../../packages/agent-runtime/src/adapters/source-review.ts', import.meta.url))),
  browserReview: 'pending' };
const persist = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
persist();
const started = Date.now();
try {
  const result = await coding.run({ workspaceId, request: log.request, conversation: log.conversation ?? [] }, store.tools(workspaceId), event => {
    if (event.type === 'coding-agent.model.updated' && event.call?.status !== 'running') {
      console.log(JSON.stringify({ call: event.call?.modelCall, status: event.call?.status, durationMs: event.call?.durationMs }));
    }
  }, AbortSignal.timeout(600000));
  report.durationMs = Date.now() - started;
  report.result = result;
  report.status = result.response?.kind === 'completed' ? 'completed' : 'not-completed';
  if (report.status !== 'completed') process.exitCode = 1;
  // Preserve the exact working files and response for semantic/browser review.
} catch (error) {
  report.durationMs = Date.now() - started;
  report.status = 'failed';
  report.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally { persist(); }
console.log(JSON.stringify({ status: report.status, durationMs: report.durationMs, output }));
