import { describe, expect, it } from 'vitest';
import { compileSourceWorkspace, refreshWorkspaceIndexes } from './source-workspace-compiler';

describe('source workspace compiler', () => {
  it('deduplicates inline computed styles into snapshot.css', () => {
    const result = compileSourceWorkspace(
      '<!doctype html><html><head><style>body{margin:0}</style></head><body><button data-ui-source-id="source-0" style="color:red;padding:8px">查询</button><button data-ui-source-id="source-1" style="color:red;padding:8px">重置</button></body></html>'
    );

    expect(result.html).not.toContain('style="');
    expect(result.html.match(/ui-snapshot-style-0/g)).toHaveLength(2);
    expect(result.css.match(/color:red;padding:8px/g)).toHaveLength(1);
    expect(result.css).toContain('body{margin:0}');
  });

  it('generates a semantic outline and source map with ancestry and lines', () => {
    const result = compileSourceWorkspace(
      '<!doctype html><html><body><main data-ui-source-id="source-0"><section data-ui-source-id="source-1" role="form"><button data-ui-source-id="source-2">提交订单</button></section></main></body></html>'
    );
    const outline = JSON.parse(result.outline);
    const sourceMap = JSON.parse(result.sourceMap);

    expect(outline.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: 'source-2',
        tag: 'button',
        text: '提交订单',
        parentSourceId: 'source-1'
      })
    ]));
    expect(sourceMap.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: 'source-2',
        file: 'index.html',
        ancestry: ['source-0', 'source-1']
      })
    ]));
    expect(sourceMap.entries.find((entry: { sourceId: string }) => entry.sourceId === 'source-2').line)
      .toBeGreaterThan(1);
  });

  it('refreshes indexes after an HTML edit without changing CSS', () => {
    const indexes = refreshWorkspaceIndexes(
      '<!doctype html><html><body><div data-ui-source-id="source-8">新内容</div></body></html>'
    );
    expect(indexes.outline).toContain('新内容');
    expect(indexes.sourceMap).toContain('source-8');
  });

  it('normalizes legacy font stacks and freezes imported snapshots to their original viewport', () => {
    const result = compileSourceWorkspace(
      '<!doctype html><html><head><style>body{padding:32px}[data-ui-agent-snapshot-stage]{width:max-content}</style></head><body><main data-ui-agent-snapshot-stage><div data-ui-source-id="source-0" style=\'font-family:"PingFang SC,Microsoft YaHei,Arial,sans-serif";width:600px\'>内容</div></main></body></html>',
      { viewport: { width: 1534, height: 911 } }
    );

    expect(result.css).toContain('font-family:PingFang SC,Microsoft YaHei,Arial,sans-serif');
    expect(result.css).toContain('html,body{width:100%;min-width:1534px;min-height:911px}');
    expect(result.css).toContain('body{padding:0!important}');
    expect(result.css).toContain('[data-ui-agent-snapshot-stage]{display:block;width:1534px!important');
    expect(result.css).toContain('margin:0 auto;transform:translateZ(0)');
  });

  it('keeps adjacent inline elements adjacent while assigning source lines', () => {
    const result = compileSourceWorkspace(
      '<!doctype html><html><body><span data-ui-source-id="source-0">合规评估</span><span data-ui-source-id="source-1">必填</span></body></html>'
    );

    expect(result.html).toMatch(/<\/span><span\n\s*data-ui-source-id="source-1"/);
    expect(result.html).not.toMatch(/<\/span>\s+<span/);
    const sourceMap = JSON.parse(result.sourceMap);
    expect(sourceMap.entries.find((entry: { sourceId: string }) => entry.sourceId === 'source-1').line)
      .toBeGreaterThan(sourceMap.entries.find((entry: { sourceId: string }) => entry.sourceId === 'source-0').line);
  });
});
