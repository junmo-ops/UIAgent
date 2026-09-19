import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0' as const;
// Large enterprise pages can legitimately contain a sizeable static DOM and
// computed-style snapshot. Keep a finite transport limit while avoiding the
// previous 10 MB false rejection for ordinary real-world pages.
export const MAX_STATIC_SNAPSHOT_HTML_CHARS = 30_000_000;

export const snapshotMetricsSchema = z.object({
  optimizationVersion: z.string().min(1).max(40),
  rawDomChars: z.number().int().nonnegative(),
  inlineStyleCharsBefore: z.number().int().nonnegative(),
  uniqueStyleRuleCount: z.number().int().nonnegative(),
  uniqueStyleChars: z.number().int().nonnegative(),
  styleDedupSavedChars: z.number().int().nonnegative(),
  pseudoStyleChars: z.number().int().nonnegative(),
  inlineDataResourceChars: z.number().int().nonnegative(),
  serializedHtmlCharsBefore: z.number().int().nonnegative(),
  serializedHtmlCharsAfter: z.number().int().nonnegative(),
  authorReadableSheets: z.number().int().nonnegative().optional(),
  authorUnreadableSheets: z.number().int().nonnegative().optional(),
  authorMissingSources: z.array(z.string().max(2_000)).max(1_000).optional()
});
export type SnapshotMetrics = z.infer<typeof snapshotMetricsSchema>;

export const authorStyleResourceSchema = z.object({
  url: z.string().url().max(4_000),
  sourceUrl: z.string().url().max(4_000),
  kind: z.enum(['image', 'font', 'other'])
});
export type AuthorStyleResource = z.infer<typeof authorStyleResourceSchema>;

export const authorStyleSheetSchema = z.object({
  sourceUrl: z.string().url().max(4_000),
  sourceKind: z.enum(['inline', 'external']).optional(),
  cssText: z.string().max(10_000_000).optional(),
  renderOnly: z.boolean(),
  media: z.string().max(2_000).optional(),
  disabled: z.boolean().optional()
});
export type AuthorStyleSheet = z.infer<typeof authorStyleSheetSchema>;

export const authorStyleCaptureSchema = z.object({
  cssText: z.string().max(30_000_000),
  readableSheets: z.number().int().nonnegative(),
  unreadableSheets: z.number().int().nonnegative(),
  missing: z.array(z.string().max(2_000)).max(1_000),
  sources: z.array(z.string().max(2_000)).max(500).optional(),
  /** Stylesheets the browser can render but the capture pipeline could not read. */
  unreadableSources: z.array(z.string().url()).max(500).optional(),
  /** Ordered stylesheet manifest used to preserve the author cascade in B. */
  sheets: z.array(authorStyleSheetSchema).max(500).optional(),
  resources: z.array(authorStyleResourceSchema).max(5_000).optional()
});
export type AuthorStyleCapture = z.infer<typeof authorStyleCaptureSchema>;

export const clarificationOptionSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  description: z.string().min(1).max(500).optional()
});
export type ClarificationOption = z.infer<typeof clarificationOptionSchema>;

export const staticSnapshotSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  title: z.string().min(1).max(200),
  sourceUrl: z.string().max(2_000),
  capturedAt: z.string().datetime(),
  html: z.string().min(1).max(MAX_STATIC_SNAPSHOT_HTML_CHARS),
  nodeCount: z.number().int().positive().max(10_000),
  selectedSourceId: z.string().min(1).max(100),
  metrics: snapshotMetricsSchema.optional(),
  authorStyles: authorStyleCaptureSchema.optional(),
  authorStyleSources: z.array(z.string().url()).max(500).optional(),
  /** Versioned B-mode visual changes carried by an exported workspace. */
  authorOverrides: z.string().max(10_000_000).optional(),
  /** Editable JSX source; the service generates the browser artifact on import. */
  moduleSource: z.string().max(500_000).optional(),
  /** Capture-time geometry/style facts, indexed separately so Agent source reads stay compact. */
  layoutIndex: z.record(z.string().min(1).max(100), z.object({
    capturedRect: z.object({
      x: z.number(), y: z.number(), width: z.number(), height: z.number()
    }).nullable().optional(),
    computedLayout: z.record(z.string(), z.string()).default({})
  })).optional(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
});
export type StaticSnapshot = z.infer<typeof staticSnapshotSchema>;

/** Structured editing intent; constraints describe requirements, not verified results. */
export const workspaceIntentSchema = z.object({
  intentId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  instruction: z.string().min(1).max(10_000),
  sourceIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  constraints: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  layoutScope: z.enum(['selected-context', 'explicit-container', 'global']).default('selected-context'),
  createdAt: z.string().datetime()
});
export type WorkspaceIntent = z.infer<typeof workspaceIntentSchema>;

export const SNAPSHOT_PACKAGE_FORMAT = 'ui-agent-static-snapshot' as const;
export const SNAPSHOT_PACKAGE_VERSION = 1 as const;

export const portableSnapshotPackageSchema = z.object({
  format: z.literal(SNAPSHOT_PACKAGE_FORMAT),
  version: z.literal(SNAPSHOT_PACKAGE_VERSION),
  exportedAt: z.string().datetime(),
  snapshot: staticSnapshotSchema,
  safety: z.object({
    activeContentRemoved: z.literal(true),
    browserStateExcluded: z.tuple([
      z.literal('cookies'),
      z.literal('localStorage'),
      z.literal('sessionStorage')
    ])
  })
});
export type PortableSnapshotPackage = z.infer<typeof portableSnapshotPackageSchema>;

/** A portable backup of every active workspace owned by one installation. */
export const WORKSPACE_ARCHIVE_FORMAT = 'ui-agent-workspace-archive' as const;
export const WORKSPACE_ARCHIVE_VERSION = 1 as const;
export const workspaceArchiveSchema = z.object({
  format: z.literal(WORKSPACE_ARCHIVE_FORMAT),
  version: z.literal(WORKSPACE_ARCHIVE_VERSION),
  exportedAt: z.string().datetime(),
  workspaces: z.array(portableSnapshotPackageSchema).min(1).max(500)
});
export type WorkspaceArchive = z.infer<typeof workspaceArchiveSchema>;
export const workspaceArchiveManifestSchema = z.object({
  format: z.literal(WORKSPACE_ARCHIVE_FORMAT),
  version: z.literal(WORKSPACE_ARCHIVE_VERSION),
  exportedAt: z.string().datetime(),
  workspaces: z.array(z.object({
    path: z.string().min(1).max(300),
    title: z.string().min(1).max(200),
    sourceUrl: z.string().max(2_000)
  })).min(1).max(500)
});
export type WorkspaceArchiveManifest = z.infer<typeof workspaceArchiveManifestSchema>;

const domAttributeNameSchema = z.string().regex(/^[A-Za-z_:][A-Za-z0-9_.:-]*$/).max(120);
const domAttributesSchema = z.record(domAttributeNameSchema, z.string().max(5_000));

export const domOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('setText'), sourceId: z.string().min(1).max(100), text: z.string().max(100_000) }),
  z.object({
    kind: z.literal('setAttributes'),
    sourceId: z.string().min(1).max(100),
    set: domAttributesSchema.default({}),
    remove: z.array(domAttributeNameSchema).max(50).default([])
  }),
  z.object({
    kind: z.literal('insert'),
    targetSourceId: z.string().min(1).max(100),
    position: z.enum(['insideStart', 'insideEnd', 'parentStart', 'parentEnd', 'before', 'after']),
    html: z.string().min(1).max(100_000)
  }),
  z.object({
    kind: z.literal('wrap'),
    sourceId: z.string().min(1).max(100),
    tagName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).max(40),
    attributes: domAttributesSchema.default({})
  }),
  z.object({ kind: z.literal('unwrap'), sourceId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('remove'), sourceId: z.string().min(1).max(100) }),
  z.object({
    kind: z.literal('move'),
    sourceId: z.string().min(1).max(100),
    position: z.enum(['insideStart', 'insideEnd', 'parentStart', 'parentEnd', 'before', 'after']),
    targetSourceId: z.string().min(1).max(100).optional()
  }),
  z.object({
    kind: z.literal('clone'),
    templateSourceId: z.string().min(1).max(100),
    position: z.enum(['replace', 'insideStart', 'insideEnd', 'parentStart', 'parentEnd', 'before', 'after']),
    targetSourceId: z.string().min(1).max(100).optional(),
    replacements: z.array(z.object({
      search: z.string().min(1).max(2_000),
      replace: z.string().max(4_000)
    })).max(50).default([])
  }),
  z.object({
    kind: z.literal('reorderChildren'),
    parentSourceId: z.string().min(1).max(100),
    orderedSourceIds: z.array(z.string().min(1).max(100)).min(1).max(200)
  })
]);
export type DomOperation = z.infer<typeof domOperationSchema>;

export const sourceTurnRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  editSessionId: z.string().min(1),
  turnId: z.string().min(1),
  traceId: z.string().min(1),
  instruction: z.string().min(1).max(10_000),
  /** User text before assistant routing or clarification-context expansion. */
  originalInstruction: z.string().min(1).max(10_000).optional(),
  /** Trace of the assistant request that produced this editing instruction. */
  assistantTraceId: z.string().min(1).optional(),
  sourceId: z.string().min(1).max(100).optional(),
  replyToClarificationId: z.string().uuid().optional(),
  clarificationOptionId: z.string().min(1).max(100).optional()
});
export type SourceTurnRequest = z.infer<typeof sourceTurnRequestSchema>;

export const sourceTurnResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('completed'),
    summary: z.string(),
    revision: z.number().int().nonnegative(),
    /** 当前副本已经满足目标时为 true；不会创建新的 Revision。 */
    unchanged: z.boolean().optional(),
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative()
  }),
  z.object({
    kind: z.literal('clarification'),
    clarificationId: z.string().uuid().optional(),
    question: z.string(),
    options: z.array(clarificationOptionSchema).min(2).max(4).optional(),
    allowFreeText: z.boolean().default(true)
  }),
  z.object({
    kind: z.literal('cancelled'),
    message: z.string()
  }),
  z.object({
    kind: z.literal('failed'),
    code: z.string(),
    message: z.string()
  })
]);
export type SourceTurnResponse = z.infer<typeof sourceTurnResponseSchema>;

export const sourceTurnAcceptedSchema = z.object({
  kind: z.literal('accepted'),
  turnId: z.string().min(1)
});
export type SourceTurnAccepted = z.infer<typeof sourceTurnAcceptedSchema>;

export const assistantConversationEntrySchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(10_000)
});
export type AssistantConversationEntry = z.infer<typeof assistantConversationEntrySchema>;

export const assistantTurnRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  turnId: z.string().uuid(),
  traceId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(10_000),
  context: z.object({
    hasWorkspace: z.boolean(),
    hasSelection: z.boolean(),
    selection: z.object({
      sourceId: z.string().min(1).max(100).optional(),
      tag: z.string().min(1).max(80),
      role: z.string().max(100).optional(),
      text: z.string().max(1_000)
    }).optional()
  }),
  conversation: z.array(assistantConversationEntrySchema).max(12).default([]),
  replyToClarificationId: z.string().uuid().optional(),
  clarificationOptionId: z.string().min(1).max(100).optional()
});
export type AssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>;

export const assistantTurnResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('answered'),
    answer: z.string().min(1).max(30_000)
  }),
  z.object({
    kind: z.literal('page_edit'),
    instruction: z.string().min(1).max(10_000),
    targetScope: z.enum(['selection', 'workspace'])
  }),
  z.object({
    kind: z.literal('clarification'),
    clarificationId: z.string().uuid(),
    question: z.string().min(1).max(2_000),
    options: z.array(clarificationOptionSchema).min(2).max(4).optional(),
    allowFreeText: z.boolean().default(true)
  }),
  z.object({
    kind: z.literal('failed'),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);
export type AssistantTurnResponse = z.infer<typeof assistantTurnResponseSchema>;

export const assistantStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answer_delta'), text: z.string().min(1) }),
  z.object({ type: z.literal('result'), result: assistantTurnResponseSchema }),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);
export type AssistantStreamEvent = z.infer<typeof assistantStreamEventSchema>;

export const modelCallProgressSchema = z.object({
  modelCall: z.number().int().positive(),
  startedAt: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  rateLimitWait: z.object({ attempt: z.number().int().positive(), retryAt: z.string() }).nullable().optional(),
  durationMs: z.number().nonnegative().optional(),
  usage: z.record(z.string(), z.number()).optional(),
  reasoning: z.string().max(12000).optional(),
  reasoningTruncated: z.boolean().optional(),
  tools: z.array(z.object({ name: z.string(), status: z.string(), durationMs: z.number().nonnegative().optional() })).optional()
});
export type ModelCallProgress = z.infer<typeof modelCallProgressSchema>;

export const sourceTurnProgressSchema = z.object({
  workspaceId: z.string().uuid(),
  turnId: z.string().min(1),
  status: z.enum(['running', 'cancelling', 'cancelled', 'completed', 'failed']),
  phase: z.enum(['analyzing', 'locating', 'reading', 'editing', 'validating', 'finishing']),
  message: z.string(),
  startedAt: z.string().optional(),
  timeline: z.array(z.object({
    id: z.string(),
    kind: z.enum(['commentary', 'tool']),
    text: z.string().max(600),
    timestamp: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'blocked', 'skipped']).optional(),
    skipReason: z.enum(['read_budget', 'duplicate_read', 'finalization_budget']).optional()
  })).max(500).optional(),
  timelineTruncated: z.boolean().optional(),
  actionSummary: z.string().max(600).optional(),
  commentary: z.array(z.object({
    modelCall: z.number().int().positive(),
    text: z.string().max(600),
    timestamp: z.string()
  })).max(8).optional(),
  execution: z.enum(['preparing', 'model', 'tool', 'settled']).optional(),
  saveState: z.enum(['not_started', 'editing', 'saving', 'saved', 'unchanged', 'unconfirmed']).optional(),
  savedRevision: z.number().int().nonnegative().optional(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  updatedAt: z.string(),
  modelDetails: z.array(modelCallProgressSchema).max(60).optional(),
  activities: z.array(z.object({
    id: z.string(),
    timestamp: z.string(),
    action: z.string(),
    label: z.string(),
    detail: z.string().optional(),
    status: z.enum(['completed', 'failed', 'blocked'])
  })).max(12),
  result: sourceTurnResponseSchema.optional()
});
export type SourceTurnProgress = z.infer<typeof sourceTurnProgressSchema>;

/** User-facing history only: no model diagnostics, tool arguments or raw reasoning. */
export const sourceTurnTranscriptSchema = sourceTurnProgressSchema.pick({
  turnId: true, status: true, startedAt: true, updatedAt: true,
  timeline: true, timelineTruncated: true, execution: true, message: true,
  saveState: true, savedRevision: true
});
export type SourceTurnTranscript = z.infer<typeof sourceTurnTranscriptSchema>;

/** A user-visible message that belongs to a static source workspace. */
export const workspaceClarificationPromptSchema = z.object({
  clarificationId: z.string().uuid(),
  options: z.array(clarificationOptionSchema).min(2).max(4).optional(),
  allowFreeText: z.boolean(),
  resolved: z.boolean().optional()
});
export type WorkspaceClarificationPrompt = z.infer<typeof workspaceClarificationPromptSchema>;

export const workspaceChatEntrySchema = z.object({
  conversationId: z.string().uuid().optional(),
  id: z.string().uuid(),
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(30_000),
  createdAt: z.string().datetime(),
  /** Workspace revision this message describes; conversation history does not roll back with the page. */
  revision: z.number().int().nonnegative(),
  clarification: workspaceClarificationPromptSchema.optional(),
  progress: sourceTurnTranscriptSchema.optional()
});
export type WorkspaceChatEntry = z.infer<typeof workspaceChatEntrySchema>;

export const workspaceConversationSchema = z.object({
  id: z.string().uuid(), title: z.string().max(80), createdAt: z.string(), updatedAt: z.string(),
  preview: z.string().max(160).optional(),
  lastRevision: z.number().int().nonnegative(),
  activeTurnId: z.string().optional()
});
export type WorkspaceConversation = z.infer<typeof workspaceConversationSchema>;
export const workspaceConversationsSchema = z.object({ conversations: z.array(workspaceConversationSchema) });

export const workspaceConversationResponseSchema = z.object({
  workspaceId: z.string().uuid(),
  entries: z.array(workspaceChatEntrySchema).max(200)
});
export type WorkspaceConversationResponse = z.infer<typeof workspaceConversationResponseSchema>;

export const sourceWorkspaceCreatedSchema = z.object({
  workspaceId: z.string().uuid(),
  previewUrl: z.string().url(),
  title: z.string(),
  selectedSourceId: z.string()
});
export type SourceWorkspaceCreated = z.infer<typeof sourceWorkspaceCreatedSchema>;

export const sourceWorkspaceInfoSchema = sourceWorkspaceCreatedSchema.extend({
  sourceUrl: z.string(),
  revision: z.number().int().nonnegative(),
  canUndo: z.boolean(),
  canRedo: z.boolean()
});
export type SourceWorkspaceInfo = z.infer<typeof sourceWorkspaceInfoSchema>;

export const managedWorkspaceSchema = sourceWorkspaceInfoSchema.extend({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional()
});
export type ManagedWorkspace = z.infer<typeof managedWorkspaceSchema>;

export const workspaceListResponseSchema = z.object({
  items: z.array(managedWorkspaceSchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive()
});
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

export const workspaceUpdateRequestSchema = z.object({
  title: z.string().trim().min(1).max(200)
});

export const installationCredentialSchema = z.object({
  accessToken: z.string().min(32),
  expiresAt: z.string().datetime()
});
export type InstallationCredential = z.infer<typeof installationCredentialSchema>;

export const elementRefSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1).max(100).optional(),
  tag: z.string().min(1),
  role: z.string().optional(),
  text: z.string(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
});
export type ElementRef = z.infer<typeof elementRefSchema>;
export const pageSelectionSchema = z.object({ selected: elementRefSchema });
export type PageSelection = z.infer<typeof pageSelectionSchema>;

export const extensionErrorCodeSchema = z.enum([
  'NO_ACTIVE_TAB',
  'EDITOR_NOT_READY',
  'TAB_UNAVAILABLE',
  'TAB_CHANGED',
  'UNSUPPORTED_PAGE',
  'INVALID_PAGE_URL',
  'ACCESS_REQUIRED',
  'CONTENT_UNAVAILABLE',
  'SCREENSHOT_PERMISSION_REQUIRED',
  'SCREENSHOT_FAILED',
  'PAGE_OPERATION_FAILED',
  'BROWSER_COMMAND_FAILED'
]);
export type ExtensionErrorCode = z.infer<typeof extensionErrorCodeSchema>;

export type ContentCommand =
  | { type: 'editorHeartbeat' }
  | { type: 'deactivateEditor' }
  | { type: 'startSelection' }
  | { type: 'capturePageSnapshot'; includeFrozenStyles?: boolean }
  | { type: 'createWorkspaceFromVisibleViewport' }
  | { type: 'bindEditorTab'; tabId: number; previewUrl: string }
  | { type: 'reloadPreview' }
  | { type: 'exportScreenshot' }
  | { type: 'prepareScreenshot' }
  | { type: 'finishScreenshot' };

export type ContentCommandResult =
  | { ok: true; selection?: PageSelection; snapshot?: StaticSnapshot; workspace?: SourceWorkspaceInfo }
  | { ok: false; code: ExtensionErrorCode; error: string };

export interface BrowserCommandRequest {
  editorClientId: string;
  command: ContentCommand;
}

export interface ExtensionProtocolMap {
  browserCommand(data: BrowserCommandRequest): ContentCommandResult;
  contentCommand(data: ContentCommand): ContentCommandResult;
  selectionChanged(data: PageSelection): void;
}
// Capture-time facts only: these must never be treated as post-edit geometry.
export const CAPTURED_LAYOUT_PROPERTIES = [
  'display', 'position', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'overflow', 'overflow-x', 'overflow-y', 'flex-direction', 'flex-wrap', 'flex-basis',
  'flex-grow', 'flex-shrink', 'align-items', 'align-content', 'justify-content',
  'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows',
  'grid-auto-flow', 'grid-column', 'grid-row'
] as const;
