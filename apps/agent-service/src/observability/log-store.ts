import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  SourceTurnRequest,
  SourceTurnResponse
} from '@ui-agent/contracts';
import type {
  CodingAgentStep,
  CodingAgentCheckpoint,
  SourceConversationTurn
} from '@ui-agent/agent-runtime';

export interface TurnLogEntry {
  id: string;
  timestamp: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'failed';
  model: { mode: string; provider: string; name?: string };
  request: SourceTurnRequest;
  conversation: SourceConversationTurn[];
  result?: SourceTurnResponse;
  sourceWorkspaceId?: string;
  codingAgent?: { adapterId: string; checkpoint: CodingAgentCheckpoint };
  sourceSteps?: CodingAgentStep[];
  error?: string;
  durationMs?: number;
}

export interface TurnLogSummary {
  id: string;
  timestamp: string;
  status: TurnLogEntry['status'];
  editSessionId: string;
  turnId: string;
  traceId: string;
  instruction: string;
  resultKind?: string;
  durationMs?: number;
  error?: string;
  model: TurnLogEntry['model'];
}

interface LogStoreOptions {
  filePath?: string;
  persist?: boolean;
  maxEntries?: number;
  maxFileBytes?: number;
  model?: TurnLogEntry['model'];
}

const sensitiveKey = /authorization|api[-_]?key|token|secret|password|cookie/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redact(item)]));
}

export class TurnLogStore {
  private readonly entries: TurnLogEntry[] = [];
  private readonly filePath?: string;
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;
  private readonly model: TurnLogEntry['model'];

  constructor(options: LogStoreOptions = {}) {
    this.filePath = options.persist === false ? undefined : resolve(options.filePath ?? '.logs/agent-turns.jsonl');
    this.maxEntries = options.maxEntries ?? 200;
    this.maxFileBytes = options.maxFileBytes ?? 5_000_000;
    this.model = options.model ?? { mode: 'mock', provider: 'mock' };
    this.load();
  }

  list(): TurnLogSummary[] {
    return [...this.entries].reverse().map(entry => ({
      id: entry.id,
      timestamp: entry.timestamp,
      status: entry.status,
      editSessionId: entry.request.editSessionId,
      turnId: entry.request.turnId,
      traceId: entry.request.traceId,
      instruction: entry.request.instruction,
      resultKind: entry.result?.kind,
      durationMs: entry.durationMs,
      error: entry.error,
      model: entry.model
    }));
  }

  get(id: string): TurnLogEntry | undefined {
    return this.entries.find(entry => entry.id === id);
  }

  recordSourceTurn(
    workspaceId: string,
    request: SourceTurnRequest,
    conversation: SourceConversationTurn[],
    response: SourceTurnResponse,
    sourceSteps: CodingAgentStep[],
    durationMs: number,
    codingAgent?: { adapterId: string; checkpoint: CodingAgentCheckpoint }
  ): void {
    const timestamp = new Date().toISOString();
    const entry = redact({
      id: `log-${crypto.randomUUID()}`,
      timestamp,
      updatedAt: timestamp,
      status: response.kind === 'failed' ? 'failed' : 'completed',
      model: this.model,
      request,
      conversation,
      result: response,
      sourceWorkspaceId: workspaceId,
      codingAgent,
      sourceSteps,
      durationMs,
      ...(response.kind === 'failed' ? { error: response.message } : {})
    }) as TurnLogEntry;
    this.entries.push(entry);
    this.trim();
    this.persist(entry);
    console.info(`[agent-log] ${entry.status} source-workspace=${workspaceId} turn=${request.turnId} durationMs=${durationMs}`);
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const latest = new Map<string, TurnLogEntry>();
    for (const line of readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as TurnLogEntry;
        if (entry.id && entry.request?.turnId) latest.set(entry.id, entry);
      } catch { /* Ignore an incomplete final line after an interrupted write. */ }
    }
    this.entries.push(...[...latest.values()].slice(-this.maxEntries));
  }

  private persist(entry: TurnLogEntry): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (statSync(this.filePath).size <= this.maxFileBytes) return;
    const rotated = `${this.filePath}.1`;
    if (existsSync(rotated)) writeFileSync(rotated, '', { mode: 0o600 });
    renameSync(this.filePath, rotated);
    writeFileSync(this.filePath, this.entries.map(item => JSON.stringify(item)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  private trim(): void {
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }
}
