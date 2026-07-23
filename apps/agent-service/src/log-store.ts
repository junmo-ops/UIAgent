import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentTurnResponse, ExecutionSubmission, PlannerResult, StartTurnRequest } from '@ui-agent/contracts';
import type { ConversationTurn, RuntimeTraceEvent } from '@ui-agent/agent-runtime';

export interface TurnLogEntry {
  id: string;
  timestamp: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'failed';
  model: { mode: string; provider: string; name?: string };
  request: StartTurnRequest;
  conversation: ConversationTurn[];
  result?: PlannerResult;
  error?: string;
  durationMs?: number;
  executions?: Array<{ timestamp: string; submission: ExecutionSubmission; response: AgentTurnResponse }>;
}

export interface TurnLogSummary {
  id: string;
  timestamp: string;
  status: TurnLogEntry['status'];
  editSessionId: string;
  turnId: string;
  traceId: string;
  instruction: string;
  resultKind?: PlannerResult['kind'];
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

  observe = (event: RuntimeTraceEvent): void => {
    if (event.type === 'turn.started') {
      const entry = redact({
        id: `log-${crypto.randomUUID()}`,
        timestamp: event.timestamp,
        updatedAt: event.timestamp,
        status: 'running',
        model: this.model,
        request: event.request,
        conversation: event.conversation
      }) as TurnLogEntry;
      this.entries.push(entry);
      this.trim();
      this.persist(entry);
      console.info(`[agent-log] started session=${entry.request.editSessionId} turn=${entry.request.turnId}`);
      return;
    }

    const entry = [...this.entries].reverse().find(item => item.request.turnId === event.request.turnId);
    if (!entry) return;
    entry.updatedAt = event.timestamp;
    entry.durationMs = event.durationMs;
    entry.conversation = redact(event.conversation) as ConversationTurn[];
    if (event.type === 'turn.completed') {
      entry.status = 'completed';
      entry.result = redact(event.result) as PlannerResult;
    } else {
      entry.status = 'failed';
      entry.error = event.error;
    }
    this.persist(entry);
    console.info(`[agent-log] ${entry.status} session=${entry.request.editSessionId} turn=${entry.request.turnId} durationMs=${entry.durationMs}`);
  };

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

  recordExecution(submission: ExecutionSubmission, response: AgentTurnResponse): void {
    const entry = [...this.entries].reverse().find(item => item.request.turnId === submission.turnId);
    if (!entry) return;
    const timestamp = new Date().toISOString();
    entry.updatedAt = timestamp;
    entry.executions ??= [];
    entry.executions.push(redact({ timestamp, submission, response }) as NonNullable<TurnLogEntry['executions']>[number]);
    this.persist(entry);
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
