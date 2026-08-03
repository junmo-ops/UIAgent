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
});
