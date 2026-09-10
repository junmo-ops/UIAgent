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

/** Immutable identity for a renderable, not-yet-committed workspace candidate. */
export const documentRefSchema = z.object({
  workspaceId: z.string().uuid(),
  baseRevision: z.number().int().nonnegative(),
  candidateId: z.string().uuid(),
  candidateVersion: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  renderMode: z.enum(['A', 'B'])
});
export type DocumentRef = z.infer<typeof documentRefSchema>;

export const candidateCreateRequestSchema = z.object({
  baseRevision: z.number().int().nonnegative().optional()
});
export const workspaceCandidateSchema = documentRefSchema.extend({
  createdAt: z.string().datetime(),
  status: z.enum(['active', 'superseded', 'discarded'])
});
export type WorkspaceCandidate = z.infer<typeof workspaceCandidateSchema>;
export const workspaceCandidateCreatedSchema = workspaceCandidateSchema.extend({
  previewUrl: z.string().url()
});
export type WorkspaceCandidateCreated = z.infer<typeof workspaceCandidateCreatedSchema>;

/** A named, versioned user intent that candidate changes and validation cite. */
export const workspaceIntentSchema = z.object({
  intentId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  instruction: z.string().min(1).max(10_000),
  // An intent must name the rendered targets and the facts to verify.  This
  // prevents a candidate from being published with an unscoped "looks good"
  // assertion that cannot be tied back to browser evidence.
  sourceIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  constraints: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  /** One-based constraint indexes that can be established from the current browser geometry. */
  // Every candidate needs at least one condition that the current browser
  // observation can decide.  Scope-only constraints remain in `constraints`,
  // but cannot silently turn a candidate into an unverified auto-publish.
  renderConstraintIndexes: z.array(z.number().int().positive()).min(1).max(100),
  layoutScope: z.enum(['selected-context', 'explicit-container', 'global']).default('selected-context'),
  createdAt: z.string().datetime()
});
export type WorkspaceIntent = z.infer<typeof workspaceIntentSchema>;

export const validationCheckResultSchema = z.object({
  id: z.string().min(1).max(160),
  required: z.boolean(),
  status: z.enum(['passed', 'failed', 'unknown']),
  message: z.string().max(2_000),
  observationId: z.string().uuid().optional(),
  artifactId: z.string().uuid().optional()
});
export type ValidationCheckResult = z.infer<typeof validationCheckResultSchema>;
/**
 * The current model integration has no image input. Geometry mode therefore
 * makes that limitation explicit and never records a fabricated visual pass.
 */
export const validationPolicySchema = z.object({
  version: z.string().min(1).max(100).default('geometry-v1'),
  visualRequired: z.boolean().default(false)
});
export const validationRecordRequestSchema = documentRefSchema.extend({
  intentId: z.string().uuid(),
  intentVersion: z.number().int().nonnegative(),
  candidateObservationId: z.string().uuid(),
  baselineObservationId: z.string().uuid().optional(),
  policy: validationPolicySchema.default({ version: 'geometry-v1', visualRequired: false }),
  staticChecks: z.object({ status: z.enum(['passed', 'failed']), message: z.string().max(4_000) }),
  constraintResults: z.array(validationCheckResultSchema).min(1).max(100),
  visualReview: z.object({ status: z.enum(['passed', 'failed', 'unknown']), message: z.string().max(4_000), artifactIds: z.array(z.string().uuid()).max(20) }).optional(),
  warnings: z.array(z.string().max(2_000)).max(100).default([])
});
export const validationRecordSchema = validationRecordRequestSchema.extend({
  validationId: z.string().uuid(),
  overall: z.enum(['passed', 'failed', 'unverifiable']),
  recordedAt: z.string().datetime()
});
export type ValidationRecord = z.infer<typeof validationRecordSchema>;

/** Requests geometry-only verification after a browser render job completed. */
export const candidateGeometryValidationRequestSchema = documentRefSchema.extend({
  intentId: z.string().uuid(),
  intentVersion: z.number().int().nonnegative(),
  candidateObservationId: z.string().uuid(),
  summary: z.string().min(1).max(2_000),
  commitId: z.string().uuid()
});
export type CandidateGeometryValidationRequest = z.infer<typeof candidateGeometryValidationRequestSchema>;

export const candidatePublishRequestSchema = documentRefSchema.extend({
  validationId: z.string().uuid(),
  summary: z.string().min(1).max(2_000),
  commitId: z.string().uuid()
});
export const candidatePublishResultSchema = z.object({
  workspaceId: z.string().uuid(),
  candidateId: z.string().uuid(),
  candidateVersion: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  committedAt: z.string().datetime(),
  unchanged: z.boolean().default(false)
});
export type CandidatePublishResult = z.infer<typeof candidatePublishResultSchema>;
/** A bounded follow-up candidate produced from failed, observation-backed checks. */
export const candidateRepairDraftSchema = z.object({
  kind: z.literal('draft'),
  summary: z.string().min(1).max(2_000),
  candidate: workspaceCandidateSchema,
  intent: workspaceIntentSchema,
  previewUrl: z.string().url(),
  renderJobId: z.string().uuid(),
  attempt: z.number().int().positive().max(2)
});
export const candidateRepairSchema = z.discriminatedUnion('kind', [
  candidateRepairDraftSchema,
  z.object({
    kind: z.literal('clarification'),
    clarificationId: z.string().uuid(),
    question: z.string().min(1).max(2_000),
    options: z.array(clarificationOptionSchema).min(2).max(4).optional(),
    allowFreeText: z.boolean().default(true),
    attempt: z.number().int().positive().max(2)
  }),
  z.object({
    kind: z.literal('failed'),
    message: z.string().min(1).max(2_000),
    attempt: z.number().int().positive().max(2)
  })
]);
export type CandidateRepair = z.infer<typeof candidateRepairSchema>;
export const candidateGeometryValidationResultSchema = z.object({
  validation: validationRecordSchema,
  publication: candidatePublishResultSchema.optional(),
  repair: candidateRepairSchema.optional()
});
export type CandidateGeometryValidationResult = z.infer<typeof candidateGeometryValidationResultSchema>;

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
    position: z.enum(['parentStart', 'parentEnd', 'before', 'after']),
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
    position: z.enum(['parentStart', 'parentEnd', 'before', 'after']),
    targetSourceId: z.string().min(1).max(100).optional()
  }),
  z.object({
    kind: z.literal('clone'),
    templateSourceId: z.string().min(1).max(100),
    position: z.enum(['replace', 'parentStart', 'parentEnd', 'before', 'after']),
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
  protocolVersion: z.literal(PROTOCOL_VERSION),
  editSessionId: z.string().min(1),
  turnId: z.string().min(1),
  traceId: z.string().min(1),
  instruction: z.string().min(1).max(10_000),
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
    kind: z.literal('draft'),
    summary: z.string(),
    candidate: workspaceCandidateSchema,
    intent: workspaceIntentSchema,
    previewUrl: z.string().url().optional(),
    renderJobId: z.string().uuid().optional(),
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative()
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

/** A user-visible message that belongs to a static source workspace. */
export const workspaceClarificationPromptSchema = z.object({
  clarificationId: z.string().uuid(),
  options: z.array(clarificationOptionSchema).min(2).max(4).optional(),
  allowFreeText: z.boolean(),
  resolved: z.boolean().optional()
});
export type WorkspaceClarificationPrompt = z.infer<typeof workspaceClarificationPromptSchema>;

export const workspaceChatEntrySchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(30_000),
  createdAt: z.string().datetime(),
  /** Workspace revision this message describes. Messages on undone branches are hidden. */
  revision: z.number().int().nonnegative(),
  clarification: workspaceClarificationPromptSchema.optional()
});
export type WorkspaceChatEntry = z.infer<typeof workspaceChatEntrySchema>;

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

const liveRectSchema = z.object({
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  top: z.number(), right: z.number(), bottom: z.number(), left: z.number()
});
export const liveObservationNodeSchema = z.object({
  sourceId: z.string().min(1).max(100),
  tag: z.string().min(1).max(80),
  text: z.string().max(2_000),
  parentSourceId: z.string().min(1).max(100).optional(),
  rect: liveRectSchema,
  clientWidth: z.number().nonnegative(),
  clientHeight: z.number().nonnegative(),
  scrollWidth: z.number().nonnegative(),
  scrollHeight: z.number().nonnegative(),
  styles: z.object({
    display: z.string(), position: z.string(), overflowX: z.string(), overflowY: z.string(),
    visibility: z.string(), opacity: z.string(), flexDirection: z.string(), gap: z.string(),
    gridTemplateColumns: z.string(), gridTemplateRows: z.string(), font: z.string(), lineHeight: z.string(),
    // Optional for older extensions; absent values are not evidence of a match.
    backgroundColor: z.string().optional(), backgroundImage: z.string().optional(),
    color: z.string().optional(), borderColor: z.string().optional(),
    borderRadius: z.string().optional(), boxShadow: z.string().optional()
  }),
  clippingAncestors: z.array(z.object({
    sourceId: z.string().min(1).max(100).optional(), tag: z.string().min(1).max(80),
    overflowX: z.string(), overflowY: z.string(), rect: liveRectSchema
  })).max(32)
});
export type LiveObservationNode = z.infer<typeof liveObservationNodeSchema>;
export const liveWorkspaceObservationSchema = z.object({
  sampleId: z.string().uuid(),
  sampledAt: z.string().datetime(),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive(), devicePixelRatio: z.number().positive() }),
  scroll: z.object({ x: z.number(), y: z.number() }),
  nodes: z.array(liveObservationNodeSchema).max(100),
  missingSourceIds: z.array(z.string().min(1).max(100)).max(100),
  readiness: z.object({
    fonts: z.enum(['ready', 'timeout', 'unsupported']),
    images: z.object({ total: z.number().int().nonnegative(), ready: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }),
    layoutStable: z.boolean()
  })
});
export type LiveWorkspaceObservation = z.infer<typeof liveWorkspaceObservationSchema>;
export const candidateObservationRequestSchema = documentRefSchema.extend({
  observation: liveWorkspaceObservationSchema,
  screenshotArtifactId: z.string().uuid().optional()
});
export const candidateObservationSchema = candidateObservationRequestSchema.extend({
  observationId: z.string().uuid(),
  recordedAt: z.string().datetime()
});
export type CandidateObservation = z.infer<typeof candidateObservationSchema>;

export const renderCaptureSchema = z.object({
  viewport: z.object({ width: z.number().positive(), height: z.number().positive(), devicePixelRatio: z.number().positive() }),
  scroll: z.object({ x: z.number(), y: z.number() }),
  pixelWidth: z.number().int().positive().max(100_000),
  pixelHeight: z.number().int().positive().max(100_000),
  // The first M1 capture is the full visible viewport; later segmented capture
  // can use this same contract without changing artifact identity.
  crop: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
});
export type RenderCapture = z.infer<typeof renderCaptureSchema>;
export const renderArtifactRequestSchema = documentRefSchema.extend({
  jobId: z.string().uuid(),
  leaseToken: z.string().uuid(),
  sampleId: z.string().uuid(),
  capture: renderCaptureSchema,
  // Browser screenshots are always PNG data URLs and are bounded before they
  // enter the service; artifacts never accept arbitrary remote URLs.
  dataUrl: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).max(30_000_000)
});
export const renderArtifactSchema = documentRefSchema.extend({
  jobId: z.string().uuid(),
  sampleId: z.string().uuid(),
  capture: renderCaptureSchema,
  artifactId: z.string().uuid(),
  mimeType: z.literal('image/png'),
  byteLength: z.number().int().positive().max(20 * 1024 * 1024),
  createdAt: z.string().datetime()
});
export type RenderArtifact = z.infer<typeof renderArtifactSchema>;

export const renderJobRequestSchema = documentRefSchema.extend({
  sourceIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  deadlineMs: z.number().int().positive().max(120_000).default(30_000),
  screenshotRequired: z.boolean().default(true)
});
export const renderJobSchema = renderJobRequestSchema.extend({
  jobId: z.string().uuid(),
  status: z.enum(['pending', 'leased', 'completed', 'failed', 'cancelled']),
  createdAt: z.string().datetime(),
  deadlineAt: z.string().datetime()
});
export type RenderJob = z.infer<typeof renderJobSchema>;
export const renderJobLeaseSchema = renderJobSchema.extend({
  leaseToken: z.string().uuid(),
  leaseExpiresAt: z.string().datetime()
});
export type RenderJobLease = z.infer<typeof renderJobLeaseSchema>;
export const renderJobResultRequestSchema = candidateObservationRequestSchema.extend({
  leaseToken: z.string().uuid()
});
export const renderJobFailureRequestSchema = documentRefSchema.extend({
  leaseToken: z.string().uuid(),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(1_000)
});
export const renderJobStatusSchema = renderJobSchema.extend({
  failure: z.string().max(1_000).optional(),
  result: candidateObservationSchema.optional()
});

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
  | { type: 'finishScreenshot' }
  | { type: 'observeWorkspacePreview'; sourceIds: string[]; document: DocumentRef; sampleId: string }
  | { type: 'readWorkspacePreviewState'; document: DocumentRef };

export type ContentCommandResult =
  | { ok: true; selection?: PageSelection; snapshot?: StaticSnapshot; workspace?: SourceWorkspaceInfo; observation?: LiveWorkspaceObservation; renderState?: { viewport: { width: number; height: number; devicePixelRatio: number }; scroll: { x: number; y: number } } }
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
