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

/**
 * Durable enough to reconnect a Side Panel to a turn that is still running
 * in the service. The formal revision remains the source of truth; this only
 * prevents a reopened panel from losing its terminal status.
 */
export interface ActiveSourceTurnSession {
  turnId: string;
  instruction: string;
  baseRevision: number;
  assistantEntryId: string;
  startedAt: string;
}

export interface PersistedWorkspaceSession {
  workspace: SourceWorkspaceInfo;
  chat: WorkspaceChatEntry[];
  editSessionId: string;
  sourceTabId?: number;
  pendingClarification?: WorkspaceClarificationPrompt;
  activeSourceTurn?: ActiveSourceTurnSession;
}

const legacySessionItem = storage.defineItem<PersistedWorkspaceSession | null>(
  'local:sourceWorkspaceSession',
  { fallback: null }
);

const workspaceSession = (workspaceId: string) => storage.defineItem<PersistedWorkspaceSession | null>(
  `local:sourceWorkspaceSession:${workspaceId}`, { fallback: null }
);

export const sourceWorkspaceSessionItem = {
  async getValue(workspaceId?: string): Promise<PersistedWorkspaceSession | null> {
    if (!workspaceId) return legacySessionItem.getValue();
    const saved = await workspaceSession(workspaceId).getValue();
    if (saved) return saved;
    const legacy = await legacySessionItem.getValue();
    if (legacy?.workspace.workspaceId !== workspaceId) return null;
    await workspaceSession(workspaceId).setValue(legacy);
    return legacy;
  },
  async setValue(value: PersistedWorkspaceSession | null) {
    if (value) await workspaceSession(value.workspace.workspaceId).setValue(value);
    // The legacy key is only the latest-created workspace handoff. Clearing it
    // when returning to the source must not erase a workspace's running turn.
    await legacySessionItem.setValue(value);
  }
};
