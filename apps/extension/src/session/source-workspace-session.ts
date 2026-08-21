import type { ClarificationOption, SourceWorkspaceInfo } from '@ui-agent/contracts';
import { storage } from 'wxt/utils/storage';

/**
 * Session state shared by the source-page panel and the preview-page panel.
 * Keeping it outside of either UI lets Background finish workspace creation
 * even after Chrome closes the source panel to restore the page viewport.
 */
export interface WorkspaceClarificationPrompt {
  clarificationId: string;
  options?: ClarificationOption[];
  allowFreeText: boolean;
}

export interface WorkspaceChatEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  clarification?: WorkspaceClarificationPrompt;
}

export interface PersistedWorkspaceSession {
  workspace: SourceWorkspaceInfo;
  chat: WorkspaceChatEntry[];
  editSessionId: string;
  sourceTabId?: number;
  pendingClarification?: WorkspaceClarificationPrompt;
}

export const sourceWorkspaceSessionItem = storage.defineItem<PersistedWorkspaceSession | null>(
  'local:sourceWorkspaceSession',
  { fallback: null }
);
