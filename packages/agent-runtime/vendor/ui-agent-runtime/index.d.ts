/**
 * UIAgent's DeepSeek-compatible Agent Runtime public surface.
 *
 * This declaration intentionally contains only the Cline Agent API subset
 * consumed by packages/agent-runtime. The implementation is the adjacent
 * Node ESM file and supports OpenAI-compatible DeepSeek endpoints only.
 */
export interface AgentToolContext {
  sessionId?: string;
  agentId: string;
  conversationId?: string;
  runId?: string;
  iteration: number;
  toolCallId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  emitUpdate?: (update: unknown) => void;
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  lifecycle?: { completesRun?: boolean };
  timeoutMs?: number;
  retryable?: boolean;
  maxRetries?: number;
  execute: (input: TInput, context: AgentToolContext) => Promise<TOutput> | TOutput;
}

export interface AgentRunResult {
  agentId: string;
  runId: string;
  status: string;
  iterations: number;
  outputText: string;
  messages: readonly unknown[];
  usage: Record<string, unknown>;
  error?: Error;
}

export type AgentRuntimeEvent =
  | { type: 'assistant-text-delta'; iteration: number; text: string; accumulatedText: string }
  | { type: string; text?: string; [key: string]: unknown };

export interface AgentOptions {
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  systemPrompt?: string;
  tools?: readonly AgentTool<any, any>[];
  maxIterations?: number;
  toolExecution?: 'sequential' | 'parallel';
  completionPolicy?: { requireCompletionTool?: boolean };
  [key: string]: unknown;
}

export class Agent {
  constructor(options: AgentOptions);
  run(input: string | unknown | readonly unknown[]): Promise<AgentRunResult>;
  abort(reason?: unknown): void;
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
}

export function createTool<TInput, TOutput>(config: AgentTool<TInput, TOutput>): AgentTool<TInput, TOutput>;
