import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type WorkspaceArchive } from '@ui-agent/contracts';
import { parseWorkspaceArchiveZip, serializeWorkspaceArchiveZip } from './workspace-archive';

const archive: WorkspaceArchive = {
  format: 'ui-agent-workspace-archive',
  version: 1,
  exportedAt: '2026-08-25T02:00:00.000Z',
  workspaces: [{
    format: 'ui-agent-static-snapshot',
    version: 1,
    exportedAt: '2026-08-25T02:00:00.000Z',
    snapshot: {
      protocolVersion: PROTOCOL_VERSION,
      title: '订单页 / 筛选',
      sourceUrl: 'https://example.test/orders',
      capturedAt: '2026-08-25T02:00:00.000Z',
      html: '<!doctype html><html><body><main data-ui-source-id="source-0">订单</main></body></html>',
      nodeCount: 1,
      selectedSourceId: 'source-0',
      viewport: { width: 1280, height: 800 }
    },
    safety: {
      activeContentRemoved: true,
      browserStateExcluded: ['cookies', 'localStorage', 'sessionStorage']
    }
  }]
};

describe('workspace archive zip', () => {
  it('round-trips all snapshots and keeps them grouped by workspace', () => {
    const bytes = serializeWorkspaceArchiveZip(archive);
    expect(bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    expect(parseWorkspaceArchiveZip(bytes)).toEqual(archive);
  });
});
