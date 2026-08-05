import { describe, expect, it } from 'vitest';
import { analyzeStaticVisibility } from './source-workspace-visibility';

describe('analyzeStaticVisibility', () => {
  it('detects a visible absolute child fully clipped by its parent', () => {
    const html = '<!doctype html><html><body><div class="rail" data-ui-source-id="source-38"><div class="panel" data-ui-source-id="source-40">历史会话</div></div></body></html>';
    const css = '.rail{width:48px;height:500px;overflow:hidden;position:relative}.panel{display:flex;position:absolute;left:48px;width:260px;height:100%}';

    expect(analyzeStaticVisibility(html, css)).toEqual([
      expect.objectContaining({
        sourceId: 'source-40',
        clippingSourceId: 'source-38',
        axis: 'horizontal'
      })
    ]);
  });

  it('does not report an intentionally hidden child or a visible child inside the clipping area', () => {
    const hiddenHtml = '<!doctype html><html><body><div class="rail" data-ui-source-id="source-1"><div class="hidden" data-ui-source-id="source-2">面板</div></div></body></html>';
    const visibleHtml = hiddenHtml.replace('class="hidden"', 'class="visible"');
    const css = '.rail{width:48px;overflow:hidden;position:relative}.hidden{display:none;position:absolute;left:48px;width:260px}.visible{display:block;position:absolute;left:0;width:48px}';

    expect(analyzeStaticVisibility(hiddenHtml, css)).toEqual([]);
    expect(analyzeStaticVisibility(visibleHtml, css)).toEqual([]);
  });
});
