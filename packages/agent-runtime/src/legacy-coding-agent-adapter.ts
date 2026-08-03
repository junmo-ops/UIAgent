import type { SourceTurnResponse } from '@ui-agent/contracts';
import {
  type CodingAgentCheckpoint,
  type CodingAgentObserver,
  type CodingAgentPort,
  type CodingAgentRunResult,
  type CodingAgentTurn,
  type CodingWorkspaceTools
} from './coding-agent-port';
import { clineCodingAgentFromEnvironment } from './cline-coding-agent-adapter';
import { SourceEditingAgent, sourceEditingAgentFromEnvironment } from './source-agent';

function responseStatus(response: SourceTurnResponse): CodingAgentCheckpoint['status'] {
  if (response.kind === 'completed') return 'completed';
  if (response.kind === 'clarification') return 'clarification';
  return 'failed';
}

export class LegacyCodingAgentAdapter implements CodingAgentPort {
  readonly adapterId = 'legacy-source-agent';

  constructor(private readonly agent: SourceEditingAgent) {}

  async run(
    turn: CodingAgentTurn,
    tools: CodingWorkspaceTools,
    observe?: CodingAgentObserver
  ): Promise<CodingAgentRunResult> {
    const emit = (event: Parameters<NonNullable<CodingAgentObserver>>[0]) => {
      try {
        observe?.(event);
      } catch {
        // Telemetry must never change the outcome of an editing turn.
      }
    };
    const startedAt = new Date().toISOString();
    const steps: CodingAgentRunResult['steps'] = [];
    let checkpoint: CodingAgentCheckpoint = {
      version: 1,
      adapterId: this.adapterId,
      workspaceId: turn.workspaceId,
      turnId: turn.request.turnId,
      status: 'running',
      modelCalls: 0,
      toolCalls: 0,
      stepCount: 0,
      updatedAt: startedAt
    };
    emit({
      type: 'coding-agent.turn.started',
      timestamp: startedAt,
      adapterId: this.adapterId,
      workspaceId: turn.workspaceId,
      request: turn.request
    });

    const response = await this.agent.run(
      turn.request,
      tools,
      turn.conversation,
      step => {
        const timestamp = new Date().toISOString();
        steps.push(step);
        checkpoint = {
          ...checkpoint,
          modelCalls: Math.max(checkpoint.modelCalls, step.modelCall),
          toolCalls: checkpoint.toolCalls + (step.action === 'finish' || step.action === 'clarify' ? 0 : 1),
          stepCount: steps.length,
          lastAction: step.action,
          updatedAt: timestamp
        };
        emit({
          type: 'coding-agent.step.completed',
          timestamp,
          adapterId: this.adapterId,
          workspaceId: turn.workspaceId,
          step
        });
        emit({ type: 'coding-agent.checkpoint.updated', timestamp, checkpoint });
      }
    );

    const timestamp = new Date().toISOString();
    checkpoint = {
      ...checkpoint,
      status: responseStatus(response),
      modelCalls: response.kind === 'completed' ? response.modelCalls : checkpoint.modelCalls,
      toolCalls: response.kind === 'completed' ? response.toolCalls : checkpoint.toolCalls,
      updatedAt: timestamp
    };
    emit({
      type: 'coding-agent.turn.completed',
      timestamp,
      adapterId: this.adapterId,
      workspaceId: turn.workspaceId,
      response,
      checkpoint
    });
    return { response, checkpoint, steps };
  }
}

export function codingAgentPortFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): CodingAgentPort {
  const adapter = env.CODING_AGENT_ADAPTER ?? 'legacy';
  if (adapter === 'legacy') {
    return new LegacyCodingAgentAdapter(sourceEditingAgentFromEnvironment(env));
  }
  if (adapter === 'cline') return clineCodingAgentFromEnvironment(env);
  throw new Error(`不支持的 Coding Agent Adapter：${adapter}`);
}
