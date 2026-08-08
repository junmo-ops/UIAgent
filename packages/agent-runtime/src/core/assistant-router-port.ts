import type {
  AssistantTurnRequest,
  ClarificationOption
} from '@ui-agent/contracts';

export type AssistantRouteResult =
  | { kind: 'chat' }
  | { kind: 'page_edit'; instruction: string; targetScope: 'selection' | 'workspace' }
  | {
      kind: 'clarification';
      clarificationId: string;
      question: string;
      options?: ClarificationOption[];
      allowFreeText: boolean;
    }
  | { kind: 'failed'; code: string; message: string };

export interface AssistantRouterPort {
  readonly adapterId: string;
  route(request: AssistantTurnRequest): Promise<AssistantRouteResult>;
}
