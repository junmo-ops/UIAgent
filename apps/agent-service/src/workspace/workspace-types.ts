import type { CodingAgentConversationTurn } from '@ui-agent/agent-runtime';
import type { StaticSnapshot, WorkspaceCandidate, SnapshotMetrics, WorkspaceChatEntry, WorkspaceConversation } from '@ui-agent/contracts';

export const WORKSPACE_FILES = ['index.html', 'snapshot.css', 'author-overrides.css', 'module.jsx', 'module.js', 'outline.json', 'source-map.json'] as const;

export const AGENT_WORKSPACE_FILES = WORKSPACE_FILES.filter(path => path !== 'module.js');

export type WorkspaceFile = typeof WORKSPACE_FILES[number];

export type WorkspaceFiles = Record<WorkspaceFile, string>;

export type CapturedLayoutIndex = NonNullable<StaticSnapshot['layoutIndex']>;

export const LAYOUT_INDEX_FILE = 'layout-index.json';

export interface CandidateManifest extends WorkspaceCandidate {
  conversationId?: string;
  workspaceId: string;
  /** Bounded, observation-triggered repair attempts for this candidate lineage. */
  repairAttempts: number;
}

export interface StructureNode {
  sourceId: string;
  tag: string;
  role?: string;
  text: string;
  depth: number;
  parentSourceId?: string;
  childrenSourceIds: string[];
  classes: string[];
}

export interface WorkspaceManifest {
  workspaceVersion?: 1 | 2;
  workspaceId: string;
  ownerId?: string;
  tenantId?: string;
  title: string;
  sourceUrl: string;
  selectedSourceId: string;
  snapshotMetrics?: SnapshotMetrics;
  viewport?: { width: number; height: number };
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  revision: number;
  maxRevision: number;
  summaries: Array<{ revision: number; summary: string; timestamp: string }>;
  conversation?: WorkspaceConversationTurn[];
  /** User-visible discussion history. It is separate from the compact Agent context above. */
  chat?: WorkspaceChatEntry[];
  conversations?: WorkspaceConversation[];
}

export interface WorkspaceConversationTurn extends CodingAgentConversationTurn {
  conversationId?: string;
  /** Workspace revision visible immediately after this turn. */
  revision?: number;
  /** Clarification awaiting a successful source-changing follow-up. */
  pending?: boolean;
  /** Stable identifier used to associate a user's follow-up with this question. */
  clarificationId?: string;
  /** Clarification answered by this turn. */
  replyToClarificationId?: string;
  /** Structured option selected for the clarification, when applicable. */
  clarificationOptionId?: string;
}

export interface SourceWorkspace {
  workspaceId: string;
  title: string;
  sourceUrl: string;
  selectedSourceId: string;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  snapshotMetrics?: SnapshotMetrics;
}

export interface WorkspaceOwner {
  userId: string;
  tenantId: string;
}

export const LOCAL_WORKSPACE_OWNER: WorkspaceOwner = {
  userId: 'local-developer',
  tenantId: 'local'
};

export interface ManagedSourceWorkspace extends SourceWorkspace {
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface WorkspaceListOptions {
  query?: string;
  offset?: number;
  limit?: number;
}

export interface SourceWorkspaceStoreOptions {
  /** Keep workspace ownership checks enabled unless a pilot explicitly opts out. */
  identityIsolation?: boolean;
  /**
   * Keep the frozen computed-style (A) variant available for diagnostics.
   * Production creation is currently wired with this disabled so replicas
   * use the author-rules (B) variant directly.
   */
  frozenStyleVariantEnabled?: boolean;
}
