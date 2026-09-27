import { parseHTML } from 'linkedom';
import type { AssistantPageContext } from '@ui-agent/agent-runtime';

interface ContentEntry {
  sourceId: string;
  region?: string;
  tag: string;
  role?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  inputType?: string;
  hiddenInSource?: boolean;
}

interface DirectoryEntry {
  sourceId: string;
  kind: 'region' | 'heading';
  tag: string;
  role?: string;
  parentRegion?: string;
  parentHeading?: string;
  level?: number;
  label?: string;
  labelTruncated?: boolean;
  hiddenInSource?: boolean;
  readScope: 'subtree' | 'section';
  contentEntries?: number;
}

/** A source-content projection, not a visibility test or a business classifier. */
export function createPageContentReader(html: string, hasModule: boolean): AssistantPageContext['readContent'] {
  let index: { entries: ContentEntry[]; ranges: Map<string, [number, number]>;
    sections: Map<string, [number, number]>; directory: DirectoryEntry[]; title: string } | undefined;
  const build = () => {
    const { document } = parseHTML(html);
    const entries: ContentEntry[] = [];
    const ranges = new Map<string, [number, number]>();
    const directory: DirectoryEntry[] = [];
    let sequence = 0;
    const roles: Record<string, string> = { main: 'main', nav: 'navigation', aside: 'complementary',
      header: 'banner', footer: 'contentinfo', button: 'button', a: 'link', select: 'combobox',
      textarea: 'textbox', table: 'table', form: 'form', h1: 'heading', h2: 'heading', h3: 'heading',
      h4: 'heading', h5: 'heading', h6: 'heading', img: 'img' };
    const landmarks = new Set(['main', 'navigation', 'complementary', 'banner', 'contentinfo', 'region', 'form', 'dialog', 'search', 'article']);
    // Iterative traversal avoids depending on any fixed DOM depth or layout.
    type Frame = { element: Element; region?: string; hidden: boolean; exit?: { id: string; start: number } };
    type TextFrame = { text: string; base: ContentEntry };
    const stack: Array<Frame | TextFrame> = [{ element: document.body, hidden: false }];
    while (stack.length) {
      const frame = stack.pop()!;
      if ('text' in frame) {
        for (let offset = 0; offset < frame.text.length; offset += 600) {
          entries.push({ ...frame.base, text: frame.text.slice(offset, offset + 600) });
        }
        continue;
      }
      if (frame.exit) { ranges.set(frame.exit.id, [frame.exit.start, entries.length]); continue; }
      const el = frame.element;
      const tag = el.localName;
      if (['script', 'style', 'template', 'noscript', 'svg'].includes(tag)) continue;
      const id = el.getAttribute('data-ui-source-id') || `content-node-${sequence++}`;
      const role = el.getAttribute('role')?.slice(0, 80) || roles[tag];
      const hidden = frame.hidden || el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true'
        || /(?:^|;)\s*display\s*:\s*none\b/i.test(el.getAttribute('style') || '');
      const isRegion = Boolean(role && landmarks.has(role)) || tag === 'article' || tag === 'section';
      const region = isRegion ? id : frame.region;
      const base = { sourceId: id, region, tag, ...(role ? { role } : {}), ...(hidden ? { hiddenInSource: true } : {}) };
      const start = entries.length;
      const label = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title');
      const placeholder = el.getAttribute('placeholder');
      const isHeading = role === 'heading';
      if (isRegion || isHeading) {
        const ariaLevel = Number(el.getAttribute('aria-level'));
        const nativeLevel = /^h[1-6]$/.test(tag) ? Number(tag[1]) : undefined;
        const level = isHeading ? (Number.isInteger(ariaLevel) && ariaLevel > 0 ? ariaLevel : nativeLevel) : undefined;
        const name = (label || (isHeading ? el.textContent : '') || '').replace(/\s+/g, ' ').trim();
        directory.push({ sourceId: id, kind: isHeading ? 'heading' : 'region', tag, role,
          parentRegion: frame.region, level, ...(name ? { label: name.slice(0, 200), labelTruncated: name.length > 200 } : {}),
          ...(hidden ? { hiddenInSource: true } : {}), readScope: isHeading && level ? 'section' : 'subtree' });
      }
      if (role || label || placeholder || tag === 'input') {
        entries.push({ ...base, ...(label ? { label: label.slice(0, 240) } : {}),
          ...(placeholder ? { placeholder: placeholder.slice(0, 240) } : {}),
          ...(tag === 'input' ? { inputType: el.getAttribute('type') || 'text' } : {}) });
      }
      stack.push({ ...frame, exit: { id, start } });
      // Text and children must remain in source order, without ancestor text duplication.
      const children = [...el.childNodes];
      const pending: Array<Frame | TextFrame> = [];
      for (const child of children) {
        if (child.nodeType === 1) pending.push({ element: child as Element, region, hidden });
        else if (child.nodeType === 3) {
          const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) {
            pending.push({ text, base });
          }
        }
      }
      for (const child of pending.reverse()) stack.push(child);
    }
    // A heading section ends at the next same/higher heading in its semantic region,
    // or the end of that region. This is source hierarchy, not inferred visual grouping.
    const sections = new Map<string, [number, number]>();
    const headingStacks = new Map<string, DirectoryEntry[]>();
    for (const item of directory) {
      const ownRange = ranges.get(item.sourceId)!;
      item.contentEntries = ownRange[1] - ownRange[0];
      if (item.kind !== 'heading' || !item.level) continue;
      const regionKey = item.parentRegion || 'document';
      const ancestors = headingStacks.get(regionKey) || [];
      while (ancestors.length && ancestors[ancestors.length - 1]!.level! >= item.level) {
        const previous = ancestors.pop()!;
        sections.get(previous.sourceId)![1] = ownRange[0];
      }
      item.parentHeading = ancestors[ancestors.length - 1]?.sourceId;
      sections.set(item.sourceId, [ownRange[0], ranges.get(regionKey)?.[1] ?? entries.length]);
      ancestors.push(item);
      headingStacks.set(regionKey, ancestors);
    }
    for (const item of directory) {
      const section = sections.get(item.sourceId);
      if (section) item.contentEntries = section[1] - section[0];
    }
    return { entries, ranges, sections, directory, title: document.title };
  };
  return async ({ view = 'content', scope = 'subtree', sourceId, offset = 0, limit = 80, maxChars }) => {
    index ??= build();
    const range = sourceId ? (scope === 'section' ? index.sections : index.ranges).get(sourceId) : [0, index.entries.length];
    if (!range) throw new Error('未找到该区域，请使用概览返回的 sourceId');
    const directoryItems = view === 'directory' ? index.directory.filter(item => {
      const own = index!.ranges.get(item.sourceId)!;
      return own[0] >= range[0]! && own[1] <= range[1]!;
    }) : [];
    const total = view === 'directory' ? directoryItems.length : range[1]! - range[0]!;
    if (offset > total) throw new Error('分页位置超出该区域范围');
    const selected: Array<ContentEntry | DirectoryEntry> = [];
    let size = 0;
    for (let i = offset; i < Math.min(total, offset + limit); i++) {
      const item = view === 'directory' ? directoryItems[i]! : index.entries[range[0]! + i]!;
      const chars = JSON.stringify(item).length + 1;
      if (size + chars > maxChars - 800) break;
      selected.push(item); size += chars;
    }
    const nextOffset = offset + selected.length;
    return JSON.stringify({ title: index.title.slice(0, 300), view, scope: sourceId || 'document', readScope: scope,
      coverage: { totalEntries: total, offset, returned: selected.length,
        hasMore: nextOffset < total, nextOffset: nextOffset < total ? nextOffset : null },
      limitations: view === 'directory'
        ? '目录仅枚举源码语义区域和标题层级，读完目录不等于读完正文。section 范围由标题级别与语义区域边界确定，不是视觉分区。无语义标记时使用内容概览；由模型判断主次，不预判正文、推荐或评论。'
        : '保存源码的文本与语义控件，按源码顺序分页；不是屏幕顺序或实时可见性。排除脚本、样式、模板和 SVG 内部；标签属性有长度限制。不读取输入值。',
      moduleSource: hasModule ? 'module.jsx 存在；运行时生成内容未必在此索引中，需要时读取源码。' : null,
      entries: selected });
  };
}
