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
  | { type: 'capturePageSnapshot' }
  | { type: 'bindEditorTab'; tabId: number; previewUrl: string }
  | { type: 'reloadPreview' }
  | { type: 'exportScreenshot' }
  | { type: 'prepareScreenshot' }
  | { type: 'finishScreenshot' };

export type ContentCommandResult =
  | { ok: true; selection?: PageSelection; snapshot?: StaticSnapshot }
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
