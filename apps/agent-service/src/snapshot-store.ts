import { randomUUID } from 'node:crypto';
import { staticSnapshotSchema, type StaticSnapshot } from '@ui-agent/contracts';

const UNSAFE_HTML_PATTERNS = [
  /<\s*(script|iframe|frame|object|embed|base)\b/i,
  /\son[a-z]+\s*=/i,
  /\ssrcdoc\s*=/i,
  /\bjavascript\s*:/i,
  /\burl\s*\(\s*["']?(?!data:)/i,
  /\s(?:src|srcset|href|action|formaction|poster)\s*=\s*["']?\s*(?:https?:|\/\/)/i
];

export interface StoredSnapshot extends StaticSnapshot {
  snapshotId: string;
}

export class SnapshotStore {
  private readonly snapshots = new Map<string, StoredSnapshot>();

  constructor(private readonly limit = 20) {}

  create(input: unknown): StoredSnapshot {
    const snapshot = staticSnapshotSchema.parse(input);
    const unsafePattern = UNSAFE_HTML_PATTERNS.find(pattern => pattern.test(snapshot.html));
    if (unsafePattern) throw new Error('快照包含脚本、事件处理器或外部资源，已拒绝保存');

    const stored = { ...snapshot, snapshotId: randomUUID() };
    this.snapshots.set(stored.snapshotId, stored);
    while (this.snapshots.size > this.limit) {
      const oldestId = this.snapshots.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.snapshots.delete(oldestId);
    }
    return stored;
  }

  get(snapshotId: string): StoredSnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }
}
