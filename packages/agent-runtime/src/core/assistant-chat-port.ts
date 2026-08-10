import type { AssistantTurnRequest } from '@ui-agent/contracts';

export type AssistantTextObserver = (text: string) => void;

export interface AssistantChatPort {
  readonly adapterId: string;
  answer(
    request: AssistantTurnRequest,
    observeText?: AssistantTextObserver,
    signal?: AbortSignal
  ): Promise<string>;
}
