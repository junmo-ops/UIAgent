import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0' as const;

export const staticSnapshotSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  title: z.string().min(1).max(200),
  sourceUrl: z.string().max(2_000),
  capturedAt: z.string().datetime(),
  html: z.string().min(1).max(10_000_000),
  nodeCount: z.number().int().positive().max(10_000),
  selectedSourceId: z.string().min(1).max(100),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
});
export type StaticSnapshot = z.infer<typeof staticSnapshotSchema>;

export const snapshotCreatedSchema = z.object({
  snapshotId: z.string().uuid(),
  previewUrl: z.string().url()
});
export type SnapshotCreated = z.infer<typeof snapshotCreatedSchema>;

export const sourceAgentDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('search'),
    query: z.string().min(1).max(500),
    path: z.string().min(1).max(200).optional(),
    reason: z.string().min(1).max(500)
  }),
  z.object({
    action: z.literal('read'),
    path: z.string().min(1).max(200),
    startLine: z.number().int().nonnegative().optional(),
    endLine: z.number().int().nonnegative().optional(),
    startChar: z.number().int().nonnegative().optional(),
    endChar: z.number().int().positive().optional(),
    reason: z.string().min(1).max(500)
  }),
  z.object({
    action: z.literal('replace'),
    path: z.string().min(1).max(200),
    search: z.string().min(1).max(30_000),
    replace: z.string().max(40_000),
    reason: z.string().min(1).max(500)
  }),
  z.object({
    action: z.literal('inspect'),
    sourceId: z.string().min(1).max(100),
    reason: z.string().min(1).max(500)
  }),
  z.object({
    action: z.literal('replaceInElement'),
    sourceId: z.string().min(1).max(100),
    search: z.string().min(1).max(10_000),
    replace: z.string().max(20_000),
    reason: z.string().min(1).max(500)
  }),
  z.object({
    action: z.literal('moveElement'),
    sourceId: z.string().min(1).max(100),
    position: z.enum(['parentStart', 'parentEnd', 'before', 'after']),
    targetSourceId: z.string().min(1).max(100).optional(),
    reason: z.string().min(1).max(500)
  }),
  z.object({
    action: z.literal('cloneElement'),
    templateSourceId: z.string().min(1).max(100),
    position: z.enum(['replace', 'parentStart', 'parentEnd', 'before', 'after']),
    targetSourceId: z.string().min(1).max(100).optional(),
    replacements: z.array(z.object({
      search: z.string().min(1).max(2_000),
      replace: z.string().max(4_000)
    })).max(50).default([]),
    reason: z.string().min(1).max(500)
  }),
  z.object({
    action: z.literal('finish'),
    summary: z.string().min(1).max(1_000)
  }),
  z.object({
    action: z.literal('clarify'),
    question: z.string().min(1).max(1_000)
  })
]);
export type SourceAgentDecision = z.infer<typeof sourceAgentDecisionSchema>;

export const sourceTurnRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  editSessionId: z.string().min(1),
  turnId: z.string().min(1),
  traceId: z.string().min(1),
  instruction: z.string().min(1).max(10_000),
  sourceId: z.string().min(1).max(100).optional()
});
export type SourceTurnRequest = z.infer<typeof sourceTurnRequestSchema>;

export const sourceTurnResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('completed'),
    summary: z.string(),
    revision: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative()
  }),
  z.object({
    kind: z.literal('clarification'),
    question: z.string()
  }),
  z.object({
    kind: z.literal('failed'),
    code: z.string(),
    message: z.string()
  })
]);
export type SourceTurnResponse = z.infer<typeof sourceTurnResponseSchema>;

export const sourceTurnProgressSchema = z.object({
  workspaceId: z.string().uuid(),
  turnId: z.string().min(1),
  status: z.enum(['running', 'completed', 'failed']),
  phase: z.enum(['analyzing', 'locating', 'reading', 'editing', 'validating', 'finishing']),
  message: z.string(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  updatedAt: z.string(),
  activities: z.array(z.object({
    id: z.string(),
    timestamp: z.string(),
    action: z.string(),
    label: z.string(),
    detail: z.string().optional(),
    status: z.enum(['completed', 'failed'])
  })).max(12)
});
export type SourceTurnProgress = z.infer<typeof sourceTurnProgressSchema>;

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

export const elementRefSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1).max(100).optional(),
  tag: z.string().min(1),
  role: z.string().optional(),
  text: z.string(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
});

export interface DomTreeNode {
  id: string;
  tag: string;
  role?: string;
  text: string;
  attributes: Record<string, string>;
  children: DomTreeNode[];
}

export const domElementFactSchema = z.object({
  id: z.string().min(1),
  tag: z.string().min(1).optional(),
  parentId: z.string().optional(),
  index: z.number().int().nonnegative(),
  semanticRole: z.string().optional(),
  text: z.string().max(300).optional(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  layout: z.object({
    display: z.string(),
    flexDirection: z.string(),
    gridTemplateColumns: z.string(),
    gap: z.string()
  })
});

export const elementIndexEntrySchema = z.object({
  id: z.string().min(1),
  tag: z.string().min(1),
  parentId: z.string().optional(),
  semanticRole: z.string().optional(),
  text: z.string().max(120),
  isSessionAdded: z.boolean().optional()
});

export const elementStyleFactSchema = z.object({
  id: z.string().min(1),
  styles: z.record(z.string(), z.string())
});

export const domTreeNodeSchema: z.ZodType<DomTreeNode> = z.lazy(() => z.object({
  id: z.string().min(1),
  tag: z.string().min(1),
  role: z.string().optional(),
  text: z.string().max(300),
  attributes: z.record(z.string(), z.string()),
  children: z.array(domTreeNodeSchema)
}));

export const contextScopeSchema = z.enum([
  'siblings',
  'visibleStyles',
  'reusableStructures',
  'elementFacts',
  'sessionChanges'
]);

export const selectedContextSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  selectionVersion: z.number().int().nonnegative(),
  pageRevision: z.number().int().nonnegative(),
  page: z.object({ title: z.string(), url: z.string(), viewportWidth: z.number(), viewportHeight: z.number() }),
  selected: elementRefSchema,
  selectedTree: domTreeNodeSchema,
  reusableTrees: z.array(domTreeNodeSchema).max(3),
  parent: z.object({ tag: z.string(), display: z.string(), flexDirection: z.string(), gap: z.string() }),
  siblings: z.array(elementRefSchema).max(8),
  visibleStyle: z.record(z.string(), z.string()),
  addedElements: z.array(elementRefSchema),
  addedTrees: z.array(domTreeNodeSchema),
  elementFacts: z.array(domElementFactSchema).max(120).optional(),
  contextScopes: z.array(contextScopeSchema).max(5).optional(),
  elementIndex: z.array(elementIndexEntrySchema).max(60).optional(),
  elementStyles: z.array(elementStyleFactSchema).max(8).optional(),
  contextTargetIds: z.array(z.string().min(1)).max(8).optional()
});

export const componentTypeSchema = z.enum([
  'button', 'text', 'link', 'input', 'select', 'checkboxGroup', 'radioGroup', 'tag', 'alert'
]);
export const componentVariantSchema = z.enum([
  'primary', 'danger', 'warning', 'success', 'info', 'neutral'
]);
export const positionSchema = z.enum(['before', 'after', 'insideStart', 'insideEnd']);

export const nodeTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), nodeId: z.string().min(1) }),
  z.object({
    kind: z.literal('result'),
    resultRef: z.string().min(1).max(80),
    path: z.array(z.number().int().nonnegative()).max(8).default([])
  })
]);

export const uiGoalSchema = z.object({
  goalId: z.string().min(1).max(80),
  action: z.enum(['create', 'update', 'remove', 'move', 'present']),
  role: z.enum([
    'button', 'text', 'link', 'input', 'select', 'checkboxGroup', 'radioGroup',
    'tag', 'alert', 'field', 'row', 'container'
  ]),
  target: nodeTargetSchema.optional(),
  resultRef: z.string().min(1).max(80).optional(),
  content: z.object({
    label: z.string().max(80).optional(),
    text: z.string().max(500).optional(),
    placeholder: z.string().max(120).optional(),
    options: z.array(z.string().max(80)).max(12).optional(),
    href: z.string().max(500).optional(),
    variant: componentVariantSchema.optional()
  }).default({}),
  placement: z.object({
    anchor: nodeTargetSchema,
    relation: positionSchema,
    strict: z.boolean().default(true),
    sameRow: z.boolean().default(false)
  }).optional(),
  state: z.object({
    name: z.enum(['open', 'selected', 'disabled']),
    value: z.boolean(),
    options: z.array(z.string().max(80)).max(12).optional()
  }).optional(),
  appearance: z.object({
    mode: z.literal('match'),
    source: nodeTargetSchema
  }).optional(),
  preserveTexts: z.array(z.string().max(200)).max(12).default([])
});

export const uiIntentSchema = z.object({
  summary: z.string().min(1).max(500),
  goals: z.array(uiGoalSchema).min(1).max(12)
});

const operationBase = z.object({ operationId: z.string().min(1) });
export const uiChangeOperationSchema = z.discriminatedUnion('type', [
  operationBase.extend({
    type: z.literal('cloneSubtree'),
    source: nodeTargetSchema,
    anchor: nodeTargetSchema,
    position: positionSchema,
    resultRef: z.string().min(1).max(80)
  }),
  operationBase.extend({
    type: z.literal('addComponent'),
    anchor: nodeTargetSchema,
    component: componentTypeSchema,
    position: positionSchema,
    resultRef: z.string().min(1).max(80).optional(),
    props: z.object({
      label: z.string().max(80).optional(),
      text: z.string().max(200).optional(),
      placeholder: z.string().max(120).optional(),
      options: z.array(z.string().max(80)).max(12).optional(),
      href: z.string().max(500).optional(),
      variant: componentVariantSchema.optional()
    })
  }),
  operationBase.extend({
    type: z.literal('updateContent'),
    target: nodeTargetSchema,
    text: z.string().max(500)
  }),
  operationBase.extend({
    type: z.literal('updateStyle'),
    target: nodeTargetSchema,
    styles: z.record(z.string(), z.string())
  }),
  operationBase.extend({
    type: z.literal('copyStyles'),
    source: nodeTargetSchema,
    target: nodeTargetSchema
  }),
  operationBase.extend({
    type: z.literal('removeElement'),
    target: nodeTargetSchema
  }),
  operationBase.extend({
    type: z.literal('moveElement'),
    target: nodeTargetSchema,
    anchor: nodeTargetSchema,
    position: positionSchema
  }),
  operationBase.extend({
    type: z.literal('setVisualState'),
    target: nodeTargetSchema,
    state: z.enum(['open', 'selected', 'disabled']),
    value: z.boolean(),
    options: z.array(z.string().max(80)).max(12).optional()
  })
]);

export const changePlanSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  planId: z.string().min(1),
  selectionVersion: z.number().int().nonnegative(),
  pageRevision: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
  intent: uiIntentSchema.optional(),
  requiresConfirmation: z.boolean(),
  operations: z.array(uiChangeOperationSchema).min(1).max(12)
});

export const clarificationSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  reason: z.string(),
  question: z.string()
});

export const contextRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  reason: z.string().min(1).max(500),
  scopes: z.array(contextScopeSchema).min(1).max(5),
  targetNodeIds: z.array(z.string().min(1)).max(8).optional()
});

export const plannerResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), plan: changePlanSchema.extend({ intent: uiIntentSchema }) }),
  z.object({ kind: z.literal('clarification'), clarification: clarificationSchema }),
  z.object({ kind: z.literal('contextRequest'), contextRequest: contextRequestSchema })
]);

export const startTurnRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  editSessionId: z.string(),
  turnId: z.string(),
  traceId: z.string(),
  instruction: z.string().min(1).max(2000),
  context: selectedContextSchema
});

export const executionReceiptSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  planId: z.string(),
  success: z.boolean(),
  pageRevision: z.number().int().nonnegative(),
  appliedOperationIds: z.array(z.string()),
  operations: z.array(z.object({
    operationId: z.string(),
    status: z.enum(['applied', 'failed', 'rolledBack']),
    verified: z.boolean(),
    resultElementId: z.string().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional()
  })),
  error: z.string().optional()
});

export const executionSubmissionSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  editSessionId: z.string(),
  turnId: z.string(),
  traceId: z.string(),
  planId: z.string(),
  beforePageRevision: z.number().int().nonnegative(),
  receipt: executionReceiptSchema,
  observation: selectedContextSchema
});

export const verificationResultSchema = z.object({
  status: z.enum(['passed', 'repairable', 'failed']),
  summary: z.string(),
  checks: z.array(z.object({
    code: z.string(),
    passed: z.boolean(),
    message: z.string()
  }))
});

export const agentTurnResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clarification'), clarification: clarificationSchema }),
  z.object({
    kind: z.literal('contextRequest'),
    contextRequest: contextRequestSchema,
    planningRound: z.number().int().min(1).max(5)
  }),
  z.object({
    kind: z.literal('execution'),
    plan: changePlanSchema,
    repairCount: z.number().int().min(0).max(1),
    verification: verificationResultSchema.optional()
  }),
  z.object({ kind: z.literal('completed'), verification: verificationResultSchema }),
  z.object({
    kind: z.literal('failed'),
    code: z.string(),
    message: z.string(),
    verification: verificationResultSchema.optional()
  })
]);

export type ElementRef = z.infer<typeof elementRefSchema>;
export type DomElementFact = z.infer<typeof domElementFactSchema>;
export type ElementIndexEntry = z.infer<typeof elementIndexEntrySchema>;
export type ElementStyleFact = z.infer<typeof elementStyleFactSchema>;
export type ContextScope = z.infer<typeof contextScopeSchema>;
export type NodeTarget = z.infer<typeof nodeTargetSchema>;
export type UiGoal = z.infer<typeof uiGoalSchema>;
export type UiIntent = z.infer<typeof uiIntentSchema>;
export type SelectedContext = z.infer<typeof selectedContextSchema>;
export type UIChangeOperation = z.infer<typeof uiChangeOperationSchema>;
export type ChangePlan = z.infer<typeof changePlanSchema>;
export type PlannerResult = z.infer<typeof plannerResultSchema>;
export type ContextRequest = z.infer<typeof contextRequestSchema>;
export type StartTurnRequest = z.infer<typeof startTurnRequestSchema>;
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;
export type OperationReceipt = ExecutionReceipt['operations'][number];
export type ExecutionSubmission = z.infer<typeof executionSubmissionSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type AgentTurnResponse = z.infer<typeof agentTurnResponseSchema>;

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
  'STALE_CONTEXT',
  'POLICY_ERROR',
  'PAGE_OPERATION_FAILED',
  'BROWSER_COMMAND_FAILED'
]);
export type ExtensionErrorCode = z.infer<typeof extensionErrorCodeSchema>;

export type ContentCommand =
  | { type: 'editorHeartbeat' }
  | { type: 'deactivateEditor' }
  | { type: 'startSelection' }
  | { type: 'selectFixture'; testId: string }
  | { type: 'getContext'; scopes?: ContextScope[]; targetNodeIds?: string[] }
  | { type: 'applyPlan'; plan: ChangePlan; confirmedExistingRemoval: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset' }
  | { type: 'captureSnapshot' }
  | { type: 'capturePageSnapshot' }
  | { type: 'bindEditorTab'; tabId: number; previewUrl: string }
  | { type: 'reloadPreview' }
  | { type: 'exportScreenshot' }
  | { type: 'prepareScreenshot' }
  | { type: 'finishScreenshot' };

export type ContentCommandResult =
  | { ok: true; context?: SelectedContext; receipt?: ExecutionReceipt; snapshot?: StaticSnapshot; canUndo?: boolean; canRedo?: boolean }
  | { ok: false; code: ExtensionErrorCode; error: string };

export interface BrowserCommandRequest {
  editorClientId: string;
  command: ContentCommand;
}

export interface ExtensionProtocolMap {
  browserCommand(data: BrowserCommandRequest): ContentCommandResult;
  contentCommand(data: ContentCommand): ContentCommandResult;
  selectionChanged(data: SelectedContext): void;
}
