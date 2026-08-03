import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@ui-agent/contracts';
import { SnapshotStore } from './snapshot-store';

const safeSnapshot = {
  protocolVersion: PROTOCOL_VERSION,
  title: '订单页 · 静态快照',
  sourceUrl: 'https://example.test/orders',
  capturedAt: '2026-07-29T10:00:00.000Z',
  html: '<!doctype html><html><body><button style="color:red">查询</button></body></html>',
  nodeCount: 1,
  selectedSourceId: 'source-0',
  viewport: { width: 1280, height: 800 }
};

describe('SnapshotStore', () => {
  it('stores safe static documents and rotates old snapshots', () => {
    const store = new SnapshotStore(1);
    const first = store.create(safeSnapshot);
    const second = store.create({ ...safeSnapshot, title: '第二个快照' });
    expect(store.get(first.snapshotId)).toBeUndefined();
    expect(store.get(second.snapshotId)?.title).toBe('第二个快照');
  });

  it.each([
    '<script>alert(1)</script>',
    '<button onclick="alert(1)">按钮</button>',
    '<img src="https://example.test/tracker.png">',
    '<div style="background:url(https://example.test/a.png)">内容</div>'
  ])('rejects active or externally connected html: %s', html => {
    const store = new SnapshotStore();
    expect(() => store.create({ ...safeSnapshot, html })).toThrow('已拒绝保存');
  });
});
