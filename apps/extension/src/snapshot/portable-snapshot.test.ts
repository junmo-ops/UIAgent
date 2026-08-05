import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, SNAPSHOT_PACKAGE_FORMAT } from '@ui-agent/contracts';
import {
  createPortableSnapshotPackage,
  parsePortableSnapshotPackage,
  portableSnapshotFilename,
  serializePortableSnapshotPackage
} from './portable-snapshot';

const snapshot = {
  protocolVersion: PROTOCOL_VERSION,
  title: '订单/列表 · 静态快照',
  sourceUrl: 'https://example.test/orders',
  capturedAt: '2026-08-04T01:02:03.000Z',
  html: '<!doctype html><html><body><button data-ui-source-id="source-0">查询</button></body></html>',
  nodeCount: 1,
  selectedSourceId: 'source-0',
  viewport: { width: 1280, height: 800 }
};

describe('portable snapshot package', () => {
  it('round-trips a sanitized static snapshot', () => {
    const value = createPortableSnapshotPackage(snapshot, '2026-08-04T02:00:00.000Z');
    const parsed = parsePortableSnapshotPackage(serializePortableSnapshotPackage(value));

    expect(parsed.format).toBe(SNAPSHOT_PACKAGE_FORMAT);
    expect(parsed.snapshot).toEqual(snapshot);
    expect(parsed.safety).toEqual({
      activeContentRemoved: true,
      browserStateExcluded: ['cookies', 'localStorage', 'sessionStorage']
    });
  });

  it('rejects malformed or incompatible files', () => {
    expect(() => parsePortableSnapshotPackage('not-json')).toThrow('有效的 JSON');
    expect(() => parsePortableSnapshotPackage(JSON.stringify({ format: SNAPSHOT_PACKAGE_FORMAT, version: 99 })))
      .toThrow('格式或版本不受支持');
  });

  it('creates a filesystem-safe descriptive filename', () => {
    expect(portableSnapshotFilename(snapshot.title, snapshot.capturedAt))
      .toBe('订单-列表-2026-08-04T01-02-03-000Z.ui-snapshot.json');
  });
});
