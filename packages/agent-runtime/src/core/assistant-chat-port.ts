import type { AssistantTurnRequest } from '@ui-agent/contracts';
import type { CodingAgentStep, CodingAgentCheckpoint } from './coding-agent-port';
import type { CodingWorkspaceTools } from './coding-agent-port';

export type WorkspaceReadTools = Pick<CodingWorkspaceTools,
  'listFiles' | 'queryWorkspaceStructure' | 'searchText' | 'readFile' | 'inspectElement'>;

/** Server-authorized, immutable saved revision; no mutation capabilities. */
export interface AssistantPageContext {
  workspaceId: string;
  revision: number;
  tools: WorkspaceReadTools;
  readContent(options: { view?: 'content' | 'directory'; scope?: 'subtree' | 'section'; sourceId?: string; offset?: number; limit?: number; maxChars: number }): Promise<string>;
}

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
    observeRun?: (run: AssistantChatRun) => void,
    page?: AssistantPageContext
  ): Promise<string>;
}
