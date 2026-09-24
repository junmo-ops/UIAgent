import type { AssistantTurnRequest } from '@ui-agent/contracts';
import type { CodingAgentStep, CodingAgentCheckpoint } from './coding-agent-port';

export type AssistantTextObserver = (text: string) => void;
export interface AssistantChatRun {
  steps: CodingAgentStep[];
  runtime?: CodingAgentCheckpoint['runtime'];
}

export interface AssistantChatPort {
  readonly adapterId: string;
  answer(
    request: AssistantTurnRequest,
    observeText?: AssistantTextObserver,
    signal?: AbortSignal,
    observeRun?: (run: AssistantChatRun) => void
  ): Promise<string>;
}
