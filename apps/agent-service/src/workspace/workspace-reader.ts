import type { WorkspaceReadTools } from '@ui-agent/agent-runtime';
import { WORKSPACE_FILES, AGENT_WORKSPACE_FILES, type WorkspaceFile, type WorkspaceFiles, type CapturedLayoutIndex, type StructureNode } from './workspace-types';
import { extractCapturedLayoutIndex, structureNeighborhood, currentSourceStructure, structureQueryTerms, sourceElementAncestry, normalizeStructureSearchText, sourceElementRange, findTagEnd, sourceLayoutFacts, relevantElementStyleContext, compactElementSource } from './source-document';

export interface WorkspaceReaderOptions {
  files(): WorkspaceFiles;
  authorRuleMode: boolean;
  authorCssContent: string;
  unreadableStyleSources: string[];
  layoutIndex(): CapturedLayoutIndex;
  viewport?: { width: number; height: number };
}

/** Shared readers: edits see their working copy; chat sees a fixed saved snapshot. */
export function createWorkspaceReader(session: WorkspaceReaderOptions): WorkspaceReadTools {
  const { authorRuleMode, authorCssContent, unreadableStyleSources } = session;
  const readableContent = (path: string): string => {
    if (path === 'author.css' && authorCssContent) return authorCssContent!;
    if (path === 'author-style-links.json' && authorRuleMode) return JSON.stringify(unreadableStyleSources, null, 2);
    if (path === 'module.js') throw new Error('module.js 是平台编译产物，请读取 module.jsx');
    assertReadablePath(path);
    const content = session.files()[path as WorkspaceFile];
    return path === 'index.html' ? extractCapturedLayoutIndex(content).html : content;
  };

  return {
    listFiles: async () => [
      ...AGENT_WORKSPACE_FILES.map(path => ({ path, chars: readableContent(path).length })),
      ...(authorCssContent ? [{ path: 'author.css', chars: authorCssContent.length }] : []),
      ...(unreadableStyleSources.length
        ? [{ path: 'author-style-links.json', chars: JSON.stringify(unreadableStyleSources).length }]
        : [])
    ],
    queryWorkspaceStructure: async (query, options = {}) => {
      const exactOutline = JSON.parse(session.files()['outline.json']) as { nodes: StructureNode[] };
      const exactNode = exactOutline.nodes.find(node => node.sourceId === query.trim());
      if (exactNode) return JSON.stringify({ query, match: 'sourceId',
        candidates: [structureNeighborhood(exactOutline.nodes, exactNode.sourceId)] });
      const terms = structureQueryTerms(query);
      if (!terms.length) throw new Error('结构查询至少需要一个长度不少于 2 的语义词');
      const outline = exactOutline;
      const selectedPath = options.selectedSourceId
        ? new Set(sourceElementAncestry(session.files()['index.html'], options.selectedSourceId).map(item => item.sourceId))
        : new Set<string>();
      const scored = outline.nodes
        .map(node => {
          const searchable = `${node.text} ${node.role ?? ''} ${node.tag} ${node.classes.join(' ')}`.toLocaleLowerCase();
          const normalizedSearchable = normalizeStructureSearchText(searchable);
          const matchedTerms = terms.filter(term => (
            searchable.includes(term) || normalizedSearchable.includes(normalizeStructureSearchText(term))
          ));
          const selectedBoost = selectedPath.has(node.sourceId) ? 2 : 0;
          return { node, matchedTerms, score: matchedTerms.length * 10 + selectedBoost };
        })
        .filter(item => item.matchedTerms.length > 0)
        .sort((left, right) => right.score - left.score || left.node.depth - right.node.depth)
        .slice(0, Math.min(Math.max(options.limit ?? 8, 1), 12));
      if (!scored.length) {
        return `结构索引中未找到与“${query}”匹配的元素。请缩短或更换语义词；只有必要时再使用 search_text 搜索源码。`;
      }
      return JSON.stringify({
        query,
        terms,
        selectedSourceId: options.selectedSourceId,
        candidates: scored.map(item => ({
          matchedTerms: item.matchedTerms,
          score: item.score,
          ...structureNeighborhood(outline.nodes, item.node.sourceId)
        }))
      }, null, 2);
    },
    searchText: async (query, path = 'index.html') => {
      const content = readableContent(path);
      const matches: Array<{ index: number; contextStart: number; contextEnd: number }> = [];
      let offset = 0;
      while (matches.length < 4) {
        const index = content.indexOf(query, offset);
        if (index < 0) break;
        matches.push({
          index,
          contextStart: Math.max(0, index - 250),
          contextEnd: Math.min(content.length, index + query.length + 250)
        });
        offset = index + Math.max(1, query.length);
      }
      const result = matches.length
        ? matches.map((item, matchIndex) => [
          `${path} 匹配 ${matchIndex + 1}：命中字符 ${item.index}，建议读取 startChar=${item.contextStart}, endChar=${item.contextEnd}`,
          content.slice(item.contextStart, item.contextEnd)
        ].join('\n')).join('\n\n')
        : `${path} 中没有找到“${query}”`;
      return result.length <= 4_000
        ? result
        : `${result.slice(0, 4_000)}\n[搜索结果已截断，请按命中位置定向读取]`;
    },
    readFile: async (path, startLine = 1, endLine, startChar, endChar) => {
      const content = readableContent(path);
      if (startChar !== undefined || endChar !== undefined) {
        const start = Math.max(0, startChar ?? 0);
        const end = Math.min(content.length, endChar ?? start + 16_000);
        if (end <= start) throw new Error('读取结束字符必须大于开始字符');
        if (end - start > 20_000) throw new Error('单次最多读取 20000 个字符');
        return `${path} 字符 ${start}-${end}：\n${content.slice(start, end)}`;
      }
      const lines = content.split('\n');
      const start = Math.max(1, startLine);
      const end = Math.min(lines.length, Math.max(start, endLine ?? start + 119));
      return lines.slice(start - 1, end)
        .map((line, index) => `${start + index}: ${line}`)
        .join('\n')
        .slice(0, 16_000);
    },
    readElementSource: async sourceId => {
      const html = session.files()['index.html'];
      const range = sourceElementRange(html, sourceId);
      const source = html.slice(range.start, range.end);
      if (source.length <= 20000) return { source, complete: true, omittedChars: 0 };
      return { source: source.slice(0, 10000) + '\n[中间源码已省略]\n' + source.slice(-10000),
        complete: false, omittedChars: source.length - 20000 };
    },
    inspectElement: async (sourceId, options = {}) => {
      const html = session.files()['index.html'];
      const full = options.detail === 'full';
      const range = sourceElementRange(html, sourceId);
      const openingTag = html.slice(range.start, findTagEnd(html, range.start) + 1);
      const ancestry = sourceElementAncestry(html, sourceId);
      const outline = JSON.parse(session.files()['outline.json']) as { nodes: StructureNode[] };
      const node = outline.nodes.find(item => item.sourceId === sourceId);
      const parent = node?.parentSourceId
        ? outline.nodes.find(item => item.sourceId === node.parentSourceId)
        : undefined;
      const siblingIds = (parent?.childrenSourceIds ?? [])
        .filter(candidate => candidate !== sourceId)
        .slice(0, 12);
      const layoutIndex = session.layoutIndex();
      // Walk the real ancestry; the peer count caps are output budgets, not
      // assumptions about which ancestor controls layout.
      let peerBudget = full ? 12 : 6;
      const ancestorPeers = ancestry.slice(0, -1).reverse().map(item => {
        const ancestor = outline.nodes.find(candidate => candidate.sourceId === item.sourceId);
        const container = outline.nodes.find(candidate => candidate.sourceId === ancestor?.parentSourceId);
        const ids = (container?.childrenSourceIds ?? []).filter(id => id !== item.sourceId);
        const included = ids.slice(0, Math.min(peerBudget, full ? 4 : 3));
        peerBudget -= included.length;
        return { ancestorSourceId: item.sourceId, containerSourceId: container?.sourceId,
          totalPeers: ids.length, omittedCount: ids.length - included.length,
          omittedSourceIds: ids.slice(included.length, included.length + 6),
          peers: included.map(id => sourceLayoutFacts(html, session.files()['snapshot.css'], layoutIndex, id, 'context')) };
      }).filter(item => item.totalPeers > 0);
      const layoutContext = {
        evidence: 'capture-time geometry; source ancestry is current; not post-edit rendering',
        ...(session.viewport ? { capturedViewport: session.viewport } : {}),
        currentSourceStructure: currentSourceStructure(outline.nodes, sourceId, full ? 64 : 32),
        ancestorPeers,
        target: sourceLayoutFacts(html, session.files()['snapshot.css'], layoutIndex, sourceId, full ? 'full' : 'target'),
        children: (node?.childrenSourceIds ?? []).slice(0, full ? 8 : 6).map(child => sourceLayoutFacts(html, session.files()['snapshot.css'], layoutIndex, child, full ? 'full' : 'context')),
        ancestors: ancestry
          .slice(0, -1)
          .slice(full ? -6 : -4)
          .reverse()
          .map(item => sourceLayoutFacts(html, session.files()['snapshot.css'], layoutIndex, item.sourceId, full ? 'full' : 'context')),
        siblings: siblingIds.slice(0, full ? 12 : 6).map(candidate => sourceLayoutFacts(
          html,
          session.files()['snapshot.css'],
          layoutIndex,
          candidate,
          full ? 'full' : 'context'
        ))
      };
      const styleSources: Array<{ path: string; content: string }> = authorRuleMode
        ? [
            { path: 'author.css', content: authorCssContent },
            { path: 'author-overrides.css', content: session.files()['author-overrides.css'] }
          ]
        : [{ path: 'snapshot.css', content: session.files()['snapshot.css'] }];
      const styleContext = relevantElementStyleContext(range.tag, openingTag, styleSources);
      return [
        `元素 ${sourceId}：tag=${range.tag}，字符 ${range.start}-${range.end}`,
        `结构路径: ${ancestry.map(item => `${item.sourceId}<${item.tag}>`).join(' > ')}`,
        `布局上下文: ${JSON.stringify(layoutContext)}`,
        ...(styleContext ? [`组件与样式上下文:\n${styleContext}`] : []),
        compactElementSource(html.slice(range.start, range.end), full ? 12_000 : 4_000)
      ].join('\n');
    },
  };
}

function assertReadablePath(path: string): asserts path is WorkspaceFile {
  if (!WORKSPACE_FILES.includes(path as WorkspaceFile)) {
    throw new Error(`源码 Agent 不能访问工作区文件 ${path}`);
  }
}
