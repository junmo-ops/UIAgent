/**
 * UIAgent's OpenAI-compatible Agent Runtime public surface.
 *
 * This declaration intentionally contains only the Cline Agent API subset
 * consumed by packages/agent-runtime. The implementation is the adjacent
 * Node ESM file and supports Chat Completions-compatible endpoints.
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
  /** Resolve conditional requirements from current state; execution must still enforce them. */
  resolveInputSchema?: (base: Record<string, unknown>) => Record<string, unknown>;
  lifecycle?: { completesRun?: boolean };
  /** Evaluated before every model call so tools can follow a generic workflow phase. */
  isAvailable?: (context: { iteration: number }) => boolean;
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
  finishReason?: string;
  diagnostics?: AgentRunDiagnostics;
  error?: Error;
}

export interface AgentRunDiagnostics {
  version: number;
  runtimeRevision: string;
  countingBasis?: string;
  maxIterations: number;
  maxOutputTokens?: number;
  requiredCompletionTool: boolean;
  continuationCount: number;
  outputLimitRecoveryCount?: number;
  protocolRecoveryCount?: number;
  completionTool?: string;
  durationMs: number;
  status: string;
  finishReason?: string;
  error?: AgentErrorDiagnostic;
  calls: Array<{
    modelCall: number;
    startedAt: string;
    status: string;
    inputMessageCount: number;
    systemPromptChars?: number;
    inputMessageChars?: number;
    toolSchemaChars?: number;
    availableTools?: string[];
    outputTextChars: number;
    /** Effective per-call generation budget; recovery may restore the configured limit. */
    outputBudget?: number;
    /** True when reported output tokens reached the effective generation budget. */
    outputBudgetReached?: boolean;
    toolChoice?: 'auto' | 'required';
    recoveringOutputLimit?: boolean;
    reasoningEffort?: 'none' | 'low' | 'high' | 'max';
    thinkingParameters?: { enable_thinking?: boolean; thinking_budget?: number; reasoning_effort?: string };
    reasoning?: string;
    reasoningTruncated?: boolean;
    firstOutputMs?: number;
    durationMs?: number;
    finishReason?: string;
    continuationReason?: string;
    rateLimitRetries?: Array<{ attempt: number; timestamp: string; waitMs: number; retryAt: string; error: AgentErrorDiagnostic }>;
    usage?: Record<string, number>;
    error?: AgentErrorDiagnostic;
    tools: Array<{ name: string; toolCallId?: string; status: string; durationMs?: number; error?: AgentErrorDiagnostic }>;
  }>;
}

export interface AgentErrorDiagnostic {
  name: string;
  statusCode?: number;
  code?: string;
  message?: string;
  requestId?: string;
  responseSummary?: string;
}

export type AgentRuntimeEvent =
  | { type: 'assistant-text-delta'; iteration: number; text: string; accumulatedText: string }
  | { type: string; text?: string; [key: string]: unknown };

export interface AgentOptions {
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  enableThinking?: boolean;
  reasoningProvider?: 'deepseek' | 'qwen';
  /** Explicit Chat Completions reasoning_effort; omitted for endpoints without this capability. */
  reasoningEffort?: 'none' | 'low' | 'high' | 'max';
  /** Evaluated once before each model call; configured phase policy only. */
  resolveReasoningEffort?: () => 'none' | 'low' | 'high' | 'max';
  /** Optional per-call budget; recovery and thinking may keep the configured limit. */
  resolveMaxOutputTokens?: (context: { reasoningEffort?: 'none' | 'low' | 'high' | 'max'; recoveringOutputLimit: boolean }) => number;
  apiProtocol?: 'chat-completions';
  headers?: Record<string, string>;
  systemPrompt?: string;
  tools?: readonly AgentTool<any, any>[];
  maxIterations?: number;
  maxOutputTokens?: number;
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
