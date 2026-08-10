import type {
  DomOperation,
  SourceTurnRequest,
  SourceTurnResponse
} from '@ui-agent/contracts';

export interface CodingWorkspaceTools {
  listFiles(): Promise<Array<{ path: string; chars: number }>>;
  searchText(query: string, path?: string): Promise<string>;
  readFile(path: string, startLine?: number, endLine?: number, startChar?: number, endChar?: number): Promise<string>;
  inspectElement(sourceId: string): Promise<string>;
  readStyleRule(className: string): Promise<string>;
  replaceText(path: string, search: string, replace: string): Promise<string>;
  applyPatch(
    path: string,
    edits: Array<
      | { kind: 'replace'; search: string; replace: string }
      | { kind: 'insert'; position: 'start' | 'end' | 'before' | 'after'; text: string; anchor?: string }
    >
  ): Promise<string>;
  replaceInElement(sourceId: string, search: string, replace: string): Promise<string>;
  setElementText(sourceId: string, text: string): Promise<string>;
  setElementAttributes(sourceId: string, set: Record<string, string>, remove: string[]): Promise<string>;
  insertElement(
    targetSourceId: string,
    position: 'parentStart' | 'parentEnd' | 'before' | 'after',
    html: string
  ): Promise<string>;
  wrapElement(sourceId: string, tagName: string, attributes: Record<string, string>): Promise<string>;
  unwrapElement(sourceId: string): Promise<string>;
  removeElement(sourceId: string): Promise<string>;
  reorderChildren(parentSourceId: string, orderedSourceIds: string[]): Promise<string>;
  applyDomOperations(operations: DomOperation[]): Promise<string>;
  moveElement(
    sourceId: string,
    position: 'parentStart' | 'parentEnd' | 'before' | 'after',
    targetSourceId?: string
  ): Promise<string>;
  cloneElement(
    templateSourceId: string,
    position: 'replace' | 'parentStart' | 'parentEnd' | 'before' | 'after',
    targetSourceId: string | undefined,
    replacements: Array<{ search: string; replace: string }>
  ): Promise<string>;
  validate(): Promise<string>;
  commit(summary: string): Promise<number>;
  rollback(): Promise<void>;
}

export interface CodingAgentConversationTurn {
  instruction: string;
  result: string;
}

export interface CodingAgentTurn {
  workspaceId: string;
  request: SourceTurnRequest;
  conversation: CodingAgentConversationTurn[];
}

export interface CodingAgentStep {
  modelCall: number;
  action: string;
  input?: unknown;
  result?: string;
  error?: string;
  /** Wall-clock time spent waiting for the model decision, including internal repair retries. */
  modelDurationMs?: number;
  /** Actual provider attempts used to obtain this decision. */
  modelAttempts?: number;
}

export interface CodingAgentCheckpoint {
  version: 1;
  adapterId: string;
  workspaceId: string;
  turnId: string;
  status: 'running' | 'completed' | 'clarification' | 'failed';
  modelCalls: number;
  toolCalls: number;
  stepCount: number;
  lastAction?: string;
  updatedAt: string;
}

export type CodingAgentEvent =
  | {
      type: 'coding-agent.turn.started';
      timestamp: string;
      adapterId: string;
      workspaceId: string;
      request: SourceTurnRequest;
    }
  | {
      type: 'coding-agent.step.completed';
      timestamp: string;
      adapterId: string;
      workspaceId: string;
      step: CodingAgentStep;
    }
  | {
      type: 'coding-agent.checkpoint.updated';
      timestamp: string;
      checkpoint: CodingAgentCheckpoint;
    }
  | {
      type: 'coding-agent.turn.completed';
      timestamp: string;
      adapterId: string;
      workspaceId: string;
      response: SourceTurnResponse;
      checkpoint: CodingAgentCheckpoint;
    };

export type CodingAgentObserver = (event: CodingAgentEvent) => void;

export interface CodingAgentRunResult {
  response: SourceTurnResponse;
  checkpoint: CodingAgentCheckpoint;
  steps: CodingAgentStep[];
}

export interface CodingAgentPort {
  readonly adapterId: string;
  run(
    turn: CodingAgentTurn,
    tools: CodingWorkspaceTools,
    observe?: CodingAgentObserver
  ): Promise<CodingAgentRunResult>;
}
