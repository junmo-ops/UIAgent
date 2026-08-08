import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownMessage } from './MarkdownMessage';

describe('MarkdownMessage', () => {
  it('renders common GFM structures with safe links', () => {
    const html = renderToStaticMarkup(<MarkdownMessage text={`## 标题

- **重点**
- \`inline\`

| 名称 | 状态 |
| --- | --- |
| 流式 | 完成 |

[文档](https://example.test)`} />);

    expect(html).toContain('<h2>标题</h2>');
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('does not render raw HTML or unsafe link protocols', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage text={'<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))'} />
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
  });
});
