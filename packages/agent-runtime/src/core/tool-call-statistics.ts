import type { CodingAgentCheckpoint, CodingAgentStep } from './coding-agent-port';

export interface ToolCallStatistics {
  attempted: number;
  succeeded: number;
  failed: number;
  blocked: number;
  pending: number;
  parameterFailures: number;
  executionFailures: number;
}

/** Count attempts including completion tools and failures before adapter execution. */
export function toolCallStatistics(
  runtime: CodingAgentCheckpoint['runtime'],
  steps: CodingAgentStep[]
): ToolCallStatistics {
  const statistics: ToolCallStatistics = {
    attempted: 0, succeeded: 0, failed: 0, blocked: 0, pending: 0,
    parameterFailures: 0, executionFailures: 0
  };
  const add = (status: string, parameterFailure = false) => {
    statistics.attempted++;
    if (status === 'succeeded') statistics.succeeded++;
    else if (status === 'blocked') statistics.blocked++;
    else if (status === 'failed') {
      statistics.failed++;
      if (parameterFailure) statistics.parameterFailures++;
      else statistics.executionFailures++;
    } else statistics.pending++;
  };
  if (runtime?.calls.length) {
    for (const call of runtime.calls) {
      const recordedIds = new Set<string>();
      for (const tool of call.tools) {
        if (tool.toolCallId) recordedIds.add(tool.toolCallId);
        add(tool.status, tool.error?.name === 'ToolInputValidationError'
          || Boolean(tool.error?.message?.startsWith('[工具参数校验]')));
      }
      // SDK input failures may be emitted without invoking a registered tool.
      const inputErrors = (call as typeof call & {
        toolInputErrors?: Array<{ toolCallId?: string }>;
      }).toolInputErrors ?? [];
      for (const error of inputErrors) {
        if (error.toolCallId && recordedIds.has(error.toolCallId)) continue;
        if (error.toolCallId) recordedIds.add(error.toolCallId);
        add('failed', true);
      }
      const requested = (call as typeof call & {
        toolCalls?: Array<{ toolCallId?: string }>;
      }).toolCalls ?? [];
      for (const request of requested) {
        // Without an ID we cannot reliably distinguish an extra attempt
        // from an execution already counted above.
        if (!request.toolCallId || recordedIds.has(request.toolCallId)) continue;
        recordedIds.add(request.toolCallId);
        add('pending');
      }
    }
  } else {
    for (const step of steps) {
      add(step.outcome ?? (step.error ? 'failed' : 'succeeded'),
        Boolean(step.error?.startsWith('[工具参数校验]')));
    }
  }
  return statistics;
}
