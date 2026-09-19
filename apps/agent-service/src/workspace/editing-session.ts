import { WORKSPACE_FILES, AGENT_WORKSPACE_FILES, type WorkspaceFile, type WorkspaceFiles, type CapturedLayoutIndex, type StructureNode } from './workspace-types';
import { compileModuleSource, validateModuleJavaScript, validateModuleBindings } from './module-compiler';
import { validateHtml, validateCss } from './source-validation';
import { structureQueryTerms, normalizeStructureSearchText, structureNeighborhood, countOccurrences, findTagEnd, sourceElementRange, sourceElementAncestry, elementClosingTagStart, cloneWithFreshSourceIds, clonedSourceScopedCss, sourceElementInnerRange, escapeHtmlText, updateOpeningTagAttributes, nextSourceNumber, fragmentWithFreshSourceIds, applyFrozenReferenceStyles, wrapperOpeningTag, withoutSourceScopedCss, compactElementSource, extractCapturedLayoutIndex, sourceLayoutFacts, cssRulesForClasses, cssRulesForClass, boundedStyleEntries, relevantElementStyleContext } from './source-document';
import { parseHTML } from 'linkedom';
import { splitCssTopLevel } from './source-document';
import type { CodingWorkspaceTools } from '@ui-agent/agent-runtime';
import { refreshWorkspaceIndexes } from './compiler';
import { analyzeStaticVisibility, staticVisibilityIssueKey } from './visibility';

export interface EditingSessionOptions {
  original: WorkspaceFiles;
  initial: WorkspaceFiles;
  authorRuleMode: boolean;
  authorCssContent: string;
  unreadableStyleSources: string[];
  layoutIndex(): CapturedLayoutIndex;
  currentRevision(): number;
  commit(files: WorkspaceFiles, summary: string): number;
  release(): void;
}

/** One in-memory edit transaction. Persistence is only invoked on commit. */
export function createEditingSession(session: EditingSessionOptions): CodingWorkspaceTools {
  const { original, initial, authorRuleMode, authorCssContent, unreadableStyleSources } = session;
  const editableStylePath = authorRuleMode ? 'author-overrides.css' : 'snapshot.css';
  let working: WorkspaceFiles = { ...original };
  const baselineVisibilityIssues = authorRuleMode
    ? new Set<string>()
    : new Set(analyzeStaticVisibility(initial['index.html'], initial['snapshot.css']).map(staticVisibilityIssueKey));
  let closed = false;
  const writeHtml = (html: string): string => {
    validateHtml(html);
    const elementFingerprint = (element: Element): string => {
      let anchor = 'document';
      let parent = element.parentElement;
      while (parent) {
        const sourceId = parent.getAttribute('data-ui-source-id');
        if (sourceId) {
          anchor = sourceId;
          break;
        }
        parent = parent.parentElement;
      }
      const attributes = [...element.attributes]
        .filter(attribute => ![
          'data-ui-source-id',
          'data-ui-agent-source-rect',
          'data-ui-agent-captured-layout'
        ].includes(attribute.name.toLowerCase()))
        .map(attribute => `${attribute.name.toLowerCase()}=${attribute.value}`)
        .sort()
        .join('|');
      const descendantIds = [...element.querySelectorAll('[data-ui-source-id]')]
        .map(descendant => descendant.getAttribute('data-ui-source-id'))
        .filter((value): value is string => Boolean(value));
      const boundaryIds = descendantIds.length > 4
        ? [...descendantIds.slice(0, 2), ...descendantIds.slice(-2)]
        : descendantIds;
      const ownText = [...element.childNodes]
        .filter(node => node.nodeType === 3)
        .map(node => node.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      return [anchor, element.localName, attributes, boundaryIds.join(','), ownText].join('::');
    };
    const previousDocument = parseHTML(working['index.html']).document;
    const previousMissing = new Map<string, number>();
    for (const element of [...previousDocument.querySelectorAll('body *:not([data-ui-source-id])')]) {
      const fingerprint = elementFingerprint(element);
      previousMissing.set(fingerprint, (previousMissing.get(fingerprint) ?? 0) + 1);
    }
    const { document } = parseHTML(html);
    const seen = new Set<string>();
    let nextId = Math.max(nextSourceNumber(original['index.html']), nextSourceNumber(working['index.html']), nextSourceNumber(html));
    const assigned = new Set<Element>();
    for (const element of [...document.querySelectorAll('body *')]) {
      const id = element.getAttribute('data-ui-source-id');
      if (id && seen.has(id)) throw new Error(`源码存在重复 sourceId：${id}，请保留原元素 ID，新增元素省略 ID 由平台生成`);
      if (id) seen.add(id);
      else {
        const fingerprint = elementFingerprint(element);
        const previousCount = previousMissing.get(fingerprint) ?? 0;
        if (previousCount > 0) {
          previousMissing.set(fingerprint, previousCount - 1);
          continue;
        }
        const createdId = `source-${nextId++}`;
        element.setAttribute('data-ui-source-id', createdId);
        seen.add(createdId);
        assigned.add(element);
      }
    }
    const next = assigned.size ? document.toString() : html;
    validateHtml(next);
    const indexes = refreshWorkspaceIndexes(next);
    const roots = [...assigned].filter(element => {
      let parent = element.parentElement;
      while (parent) {
        if (assigned.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    }).map(element => element.getAttribute('data-ui-source-id'));
    working['index.html'] = next;
    working['outline.json'] = indexes.outline;
    working['source-map.json'] = indexes.sourceMap;
    return roots.length ? `；已补齐 sourceId，新增顶层元素：${roots.join(', ')}；字符位置可能变化，请以当前源码为准` : '';
  };
  const refreshIndexes = () => {
    const indexes = refreshWorkspaceIndexes(working['index.html']);
    working['outline.json'] = indexes.outline;
    working['source-map.json'] = indexes.sourceMap;
  };
  const validateWorking = () => {
    validateHtml(working['index.html']);
    validateCss(working[editableStylePath]);
    // JSX is compiled atomically by the source-edit tools; validation does
    // not need to recompile unchanged source on both validate and commit.
    validateModuleJavaScript(working['module.js']);
    validateModuleBindings(working['index.html'], working['module.jsx']);
    const newVisibilityIssues = authorRuleMode ? [] : analyzeStaticVisibility(
      working['index.html'],
      working['snapshot.css']
    ).filter(issue => !baselineVisibilityIssues.has(staticVisibilityIssueKey(issue)));
    if (newVisibilityIssues.length) {
      throw new Error(`静态可见性校验失败：${newVisibilityIssues.slice(0, 3).map(issue => issue.message).join('；')}。请调整父容器尺寸、overflow 或元素定位后重新校验。`);
    }
    return authorRuleMode
      ? 'HTML、author-overrides.css 与安全规则校验通过；原始规则模式仍需真实浏览器几何验证'
      : 'HTML、CSS、结构、安全与静态可见性规则校验通过';
  };
  const close = () => {
    if (closed) return;
    closed = true;
    session.release();
  };
  const readableContent = (path: string): string => {
    if (path === 'author.css' && authorCssContent) return authorCssContent!;
    if (path === 'author-style-links.json' && authorRuleMode) return JSON.stringify(unreadableStyleSources, null, 2);
    if (path === 'module.js') throw new Error('module.js 是平台编译产物，请读取并修改 module.jsx');
    assertReadablePath(path);
    const content = working[path as WorkspaceFile];
    return path === 'index.html' ? extractCapturedLayoutIndex(content).html : content;
  };

  let toolset!: CodingWorkspaceTools;
  toolset = {
    listFiles: async () => [
      ...AGENT_WORKSPACE_FILES.map(path => ({ path, chars: readableContent(path).length })),
      ...(authorCssContent ? [{ path: 'author.css', chars: authorCssContent.length }] : []),
      ...(unreadableStyleSources.length
        ? [{ path: 'author-style-links.json', chars: JSON.stringify(unreadableStyleSources).length }]
        : [])
    ],
    queryWorkspaceStructure: async (query, options = {}) => {
      const exactOutline = JSON.parse(working['outline.json']) as { nodes: StructureNode[] };
      const exactNode = exactOutline.nodes.find(node => node.sourceId === query.trim());
      if (exactNode) return JSON.stringify({ query, match: 'sourceId',
        candidates: [structureNeighborhood(exactOutline.nodes, exactNode.sourceId)] });
      const terms = structureQueryTerms(query);
      if (!terms.length) throw new Error('结构查询至少需要一个长度不少于 2 的语义词');
      const outline = exactOutline;
      const selectedPath = options.selectedSourceId
        ? new Set(sourceElementAncestry(working['index.html'], options.selectedSourceId).map(item => item.sourceId))
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
    inspectElement: async (sourceId, options = {}) => {
      const html = working['index.html'];
      const full = options.detail === 'full';
      const range = sourceElementRange(html, sourceId);
      const openingTag = html.slice(range.start, findTagEnd(html, range.start) + 1);
      const ancestry = sourceElementAncestry(html, sourceId);
      const outline = JSON.parse(working['outline.json']) as {
        nodes: Array<{
          sourceId: string;
          parentSourceId?: string;
          childrenSourceIds: string[];
        }>;
      };
      const node = outline.nodes.find(item => item.sourceId === sourceId);
      const parent = node?.parentSourceId
        ? outline.nodes.find(item => item.sourceId === node.parentSourceId)
        : undefined;
      const siblingIds = (parent?.childrenSourceIds ?? [])
        .filter(candidate => candidate !== sourceId)
        .slice(0, 12);
      const layoutIndex = session.layoutIndex();
      const layoutContext = {
        target: sourceLayoutFacts(html, working['snapshot.css'], layoutIndex, sourceId, full ? 'full' : 'target'),
        children: (node?.childrenSourceIds ?? []).slice(0, full ? 8 : 6).map(child => sourceLayoutFacts(html, working['snapshot.css'], layoutIndex, child, full ? 'full' : 'context')),
        ancestors: ancestry
          .slice(0, -1)
          .slice(full ? -6 : -4)
          .reverse()
          .map(item => sourceLayoutFacts(html, working['snapshot.css'], layoutIndex, item.sourceId, full ? 'full' : 'context')),
        siblings: siblingIds.slice(0, full ? 12 : 6).map(candidate => sourceLayoutFacts(
          html,
          working['snapshot.css'],
          layoutIndex,
          candidate,
          full ? 'full' : 'context'
        ))
      };
      const styleSources: Array<{ path: string; content: string }> = authorRuleMode
        ? [
            { path: 'author.css', content: authorCssContent },
            { path: 'author-overrides.css', content: working['author-overrides.css'] }
          ]
        : [{ path: 'snapshot.css', content: working['snapshot.css'] }];
      const styleContext = relevantElementStyleContext(range.tag, openingTag, styleSources);
      return [
        `元素 ${sourceId}：tag=${range.tag}，字符 ${range.start}-${range.end}`,
        `结构路径: ${ancestry.map(item => `${item.sourceId}<${item.tag}>`).join(' > ')}`,
        `布局上下文: ${JSON.stringify(layoutContext)}`,
        ...(styleContext ? [`组件与样式上下文:\n${styleContext}`] : []),
        compactElementSource(html.slice(range.start, range.end), full ? 12_000 : 4_000)
      ].join('\n');
    },
    queryStyleSymbols: async (symbols, options = {}) => {
      const sources: Array<{ path: string; content: string }> = authorRuleMode
        ? [
            { path: 'author.css', content: authorCssContent },
            { path: 'author-overrides.css', content: working['author-overrides.css'] }
          ]
        : [{ path: 'snapshot.css', content: working['snapshot.css'] }];
      const selectedSources = sources.filter(source => options.source === 'overrides'
        ? source.path === editableStylePath
        : options.source === 'original' ? source.path !== 'author-overrides.css' : true);
      const normalizeProperty = (value: string) => value.trim().startsWith('--') ? value.trim() : value.trim().toLowerCase();
      const properties = [...new Set((options.properties ?? []).map(normalizeProperty))];
      if (properties.some(value => !/^(?:--)?[a-z][a-z0-9-]*$/i.test(value))) throw new Error('CSS 属性名格式无效');
      const document = options.sourceId ? parseHTML(working['index.html']).document : undefined;
      const target = options.sourceId
        ? [...document!.querySelectorAll('[data-ui-source-id]')].find(element => element.getAttribute('data-ui-source-id') === options.sourceId)
        : undefined;
      if (options.sourceId && !target) throw new Error(`未找到元素 ${options.sourceId}`);
      const normalized = [...new Set(symbols)].map(rawSymbol => {
        const symbol = rawSymbol.trim();
        if (!/^(?:\.?[a-zA-Z_][\w-]{0,119}|--[a-zA-Z_][\w-]{0,117})$/.test(symbol)) {
          throw new Error(`样式符号格式无效：${rawSymbol}`);
        }
        return { symbol, variable: symbol.startsWith('--'), className: symbol.replace(/^\./, '') };
      });
      const classNames = normalized.filter(item => !item.variable).map(item => item.className);
      let unknownSelectors = 0;
      const uncertainSelectors = new Set<string>();
      const matchesTarget = (selector: string, element: NonNullable<typeof target>): boolean => {
        return splitCssTopLevel(selector, ',').some(part => {
          // Only strip a terminal pseudo-element. Match its originating element;
          // do not drop arbitrary pseudo-classes inside :not/:is/:has.
          const trimmed = part.trim();
          const origin = trimmed.replace(/::[\w-]+(?:\([^()]*\))?\s*$/, '').trim() || '*';
          try {
            const matches = element.matches(origin);
            if (matches && origin !== trimmed) uncertainSelectors.add(selector);
            return matches;
          } catch {
            unknownSelectors++;
            return false;
          }
        });
      };
      const variableRules = (content: string, variable: string) => {
        const declarations = (body: string) => splitCssTopLevel(body, ';')
          .map(value => value.replace(/^(?:\s|\/\*[\s\S]*?\*\/)+/, '').trim())
          .filter(value => value.slice(0, value.indexOf(':')).trim() === variable);
        return cssRulesForClasses(content, [], Number.POSITIVE_INFINITY, (selector, body) => {
          if (!declarations(body).length) return false;
          if (!target) return true;
          const elementSelectors = splitCssTopLevel(selector, ',').filter(part => !part.includes('::')).join(',');
          if (!elementSelectors) return false;
          for (let element: typeof target | null = target; element; element = element.parentElement) {
            if (matchesTarget(elementSelectors, element)) return true;
          }
          return false;
        }, body => declarations(body).join('; ') + ';').get('') ?? [];
      };
      const acceptRule = (selector: string, body: string) => {
        if (properties.length) {
          const declarations = [...body.matchAll(/(?:^|[;{}])\s*([\w-]+)\s*:/g)].map(match => normalizeProperty(match[1]!));
          if (!declarations.some(name => name === 'all' || properties.some(property => name === property
            || name.startsWith(property + '-') || property.startsWith(name + '-') || name.endsWith('-' + property)))) return false;
        }
        if (!target) return true;
        return matchesTarget(selector, target);
      };
      const ruleIndexes = new Map(selectedSources.map(source => [
        source.path,
        cssRulesForClasses(source.content, target ? [] : classNames, Number.POSITIVE_INFINITY, acceptRule)
      ]));
      let matchedSymbols = 0;
      const sections = normalized.flatMap(({ symbol, variable, className }) => {
        const matches = [...selectedSources].sort((a, b) => Number(b.path === 'author-overrides.css') - Number(a.path === 'author-overrides.css')).flatMap(source => {
          const values = variable
            ? variableRules(source.content, symbol)
            : ruleIndexes.get(source.path)?.get(className) ?? [];
          return values.map(value => `${symbol} — ${source.path}${variable ? '（仅指定变量声明摘录，非完整规则）' : ''}: ${value}`);
        });
        if (matches.length) matchedSymbols += 1;
        return matches.length
          ? matches
          : [`${symbol}：未提取到可读取的完整规则或引用（不代表原始 CSS 中不存在）`];
      });
      if (target) {
        sections.length = 0;
        for (const source of [...selectedSources].reverse()) {
          const isUncertain = (rule: string) => [...uncertainSelectors].some(selector => rule.includes(selector + '{') || rule.includes(selector + ' {'));
          const rules = [...new Set((ruleIndexes.get(source.path)?.get('') ?? []))]
            .sort((a, b) => Number(isUncertain(a)) - Number(isUncertain(b)));
          for (const rule of rules) sections.push(`${source.path}（${isUncertain(rule) ? '状态或选择器待核对' : '静态结构匹配，条件待核对'}）: ${rule}`);
        }
      }
      // Derive variable lookups only from the evidence actually delivered.
      sections.sort((a, b) => Number(b.includes('author-overrides.css')) - Number(a.includes('author-overrides.css'))
        || Number(b.startsWith('--')) - Number(a.startsWith('--')));
      const visibleSections = boundedStyleEntries(sections, 4_500);
      const variables = [...visibleSections.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]!);
      const requestedVariables = [...new Set(variables)].slice(0, 8);
      const variableSections = requestedVariables.flatMap(variable => selectedSources.flatMap(source =>
        variableRules(source.content, variable).map(rule => `${variable} — ${source.path}（变量定义，需核对继承及作用域）: ${rule}`)));
      const header = `样式查询：来源=${options.source ?? 'all'}；目标=${options.sourceId ?? '按符号'}；关注属性=${properties.join(', ') || '全部'}。候选规则不是浏览器最终计算样式；状态、伪元素、媒体条件及嵌套选择器仍需核对。\n`
        + (target ? `当前目标行内样式: ${target.getAttribute('style') ?? '无'}\n` : `请求 ${normalized.length} 个符号，命中 ${matchedSymbols} 个。\n`);
      return header + (sections.length ? visibleSections : '未命中相关规则；无需因此重复读取，可按现有证据修改或调整查询条件。')
        + (variableSections.length ? '\n变量声明摘录（仅保留指定声明，保留选择器及条件；不是整条规则）:\n' + boundedStyleEntries(variableSections, 1_500) : '')
        + (unknownSelectors ? `\n[${unknownSelectors} 次选择器匹配无法静态解析，未混入目标结果；不代表这些规则不存在，必要时按符号查询原始规则。]` : '');
    },
    readStyleRule: async rawClassName => {
      const className = rawClassName.replace(/^\./, '');
      if (!/^[a-zA-Z0-9_-]{1,120}$/.test(className)) {
        throw new Error('样式类名格式无效，请传入 inspect_element 返回的单个 class 名');
      }
      // In B mode only the editable override layer can have been changed by
      // this turn. Spatial validation reads that layer to reject new fixed
      // positioning without treating immutable author.css as editable.
      const stylePath = authorRuleMode ? 'author-overrides.css' : 'snapshot.css';
      const rules = cssRulesForClass(working[stylePath], className);
      if (!rules.length) throw new Error(`${stylePath} 中不存在 .${className} 规则`);
      return `${stylePath} 中 .${className} 命中的 ${rules.length} 条规则（含组合选择器和伪类状态）：\n${boundedStyleEntries(rules, 16_000)}`;
    },
    replaceText: async (path, search, replacement) => {
      assertEditablePath(path, editableStylePath);
      const file = path as Extract<WorkspaceFile, 'index.html' | 'snapshot.css' | 'author-overrides.css' | 'module.jsx'>;
      const content = working[file];
      const occurrences = countOccurrences(content, search);
      if (occurrences !== 1) {
        throw new Error(occurrences === 0
          ? '替换原文与当前文件不匹配，请重新读取相关片段'
          : `替换原文出现 ${occurrences} 次，请提供更完整的唯一上下文`);
      }
      const next = content.replace(search, replacement);
      let identityResult = '';
      if (file === 'index.html') {
        identityResult = writeHtml(next);
      } else if (file === 'module.jsx') {
        const compiled = compileModuleSource(next);
        working[file] = next;
        working['module.js'] = compiled;
      } else {
        validateCss(next);
        working[file] = next;
      }
      return `替换成功；${file} 当前 ${working[file].length} 字符；工作区校验通过${identityResult}`;
    },
    applyPatch: async (path, edits) => {
      assertEditablePath(path, editableStylePath);
      if (!Array.isArray(edits)) throw new Error('apply_patch 缺少 edits 数组；本次未执行写入');
      if (edits.length < 1 || edits.length > 20) throw new Error('Patch 必须包含 1-20 个编辑操作');
      const file = path as Extract<WorkspaceFile, 'index.html' | 'snapshot.css' | 'author-overrides.css' | 'module.jsx'>;
      let next = working[file];
      for (const [index, edit] of edits.entries()) {
        if (edit.kind === 'replace') {
          if (!edit.search) throw new Error(`Patch 第 ${index + 1} 项的 search 不能为空`);
          if (typeof edit.replace !== 'string') throw new Error(`Patch 第 ${index + 1} 项的 replace 必须是字符串`);
          const occurrences = countOccurrences(next, edit.search);
          if (occurrences !== 1) {
            throw new Error(occurrences === 0
              ? `Patch 第 ${index + 1} 项的替换原文与当前文件不匹配`
              : `Patch 第 ${index + 1} 项的替换原文出现 ${occurrences} 次`);
          }
          next = next.replace(edit.search, edit.replace);
          continue;
        }
        if (typeof edit.text !== 'string' || !edit.text) {
          throw new Error(`Patch 第 ${index + 1} 项的插入内容不能为空`);
        }
        if (edit.position === 'start') {
          next = `${edit.text}${next}`;
          continue;
        }
        if (edit.position === 'end') {
          next = `${next}${edit.text}`;
          continue;
        }
        if (!edit.anchor) throw new Error(`Patch 第 ${index + 1} 项必须提供 anchor`);
        const occurrences = countOccurrences(next, edit.anchor);
        if (occurrences !== 1) {
          throw new Error(occurrences === 0
            ? `Patch 第 ${index + 1} 项的插入锚点与当前文件不匹配`
            : `Patch 第 ${index + 1} 项的插入锚点出现 ${occurrences} 次`);
        }
        const anchorIndex = next.indexOf(edit.anchor);
        const insertionIndex = edit.position === 'before'
          ? anchorIndex
          : anchorIndex + edit.anchor.length;
        next = `${next.slice(0, insertionIndex)}${edit.text}${next.slice(insertionIndex)}`;
      }
      let identityResult = '';
      if (file === 'index.html') {
        identityResult = writeHtml(next);
      } else if (file === 'module.jsx') {
        const compiled = compileModuleSource(next);
        working[file] = next;
        working['module.js'] = compiled;
      } else {
        validateCss(next);
        working[file] = next;
      }
      return `Patch 成功应用 ${edits.length} 项；${file} 当前 ${working[file].length} 字符；工作区校验通过${identityResult}`;
    },
    replaceInElement: async (sourceId, search, replacement) => {
      const html = working['index.html'];
      const range = sourceElementRange(html, sourceId);
      const outerHtml = html.slice(range.start, range.end);
      const occurrences = countOccurrences(outerHtml, search);
      if (occurrences !== 1) {
        throw new Error(occurrences === 0
          ? `替换原文不在元素 ${sourceId} 内，请先 inspect 该元素并使用 rawTextSegments 中的精确原文`
          : `替换原文在元素 ${sourceId} 内出现 ${occurrences} 次，请提供更完整的唯一上下文`);
      }
      const updatedElement = outerHtml.replace(search, replacement);
      const next = `${html.slice(0, range.start)}${updatedElement}${html.slice(range.end)}`;
      const identityResult = writeHtml(next);
      return `元素 ${sourceId} 内替换成功；HTML 与安全规则校验通过${identityResult}`;
    },
    replaceElement: async (sourceId, fragmentHtml) => {
      if (typeof fragmentHtml !== 'string' || !fragmentHtml.trim()) {
        throw new Error('replace_element 缺少有效的 html；本次未执行写入');
      }
      const html = working['index.html'];
      const range = sourceElementRange(html, sourceId);
      const removedHtml = html.slice(range.start, range.end);
      const removedSourceIds = [...removedHtml.matchAll(
        /\bdata-ui-source-id\s*=\s*["']([^"']+)["']/gi
      )].map(match => match[1]!);
      const replacement = fragmentWithFreshSourceIds(html, fragmentHtml);
      if (replacement.rootSourceIds.length !== 1) {
        throw new Error(`replace_element 必须提供且仅提供一个顶层元素，当前为 ${replacement.rootSourceIds.length} 个；本次未执行写入`);
      }
      const next = `${html.slice(0, range.start)}${replacement.html}${html.slice(range.end)}`;
      validateHtml(next);
      working['index.html'] = next;
      working[editableStylePath] = withoutSourceScopedCss(working[editableStylePath], removedSourceIds);
      validateCss(working[editableStylePath]);
      refreshIndexes();
      return `元素 ${sourceId} 已由新元素替换；新增顶层元素：${replacement.rootSourceIds[0]}；原位置保持不变，${removedSourceIds.length} 个原 sourceId 及其专属样式已移除；HTML、CSS、结构与安全规则校验通过`;
    },
    setElementText: async (sourceId, text) => {
      const html = working['index.html'];
      const range = sourceElementRange(html, sourceId);
      const inner = sourceElementInnerRange(html, range);
      const removedSourceIds = [...html.slice(inner.start, inner.end).matchAll(
        /\bdata-ui-source-id\s*=\s*["']([^"']+)["']/gi
      )].map(match => match[1]!);
      const next = `${html.slice(0, inner.start)}${escapeHtmlText(text)}${html.slice(inner.end)}`;
      validateHtml(next);
      working['index.html'] = next;
      working[editableStylePath] = withoutSourceScopedCss(working[editableStylePath], removedSourceIds);
      validateCss(working[editableStylePath]);
      refreshIndexes();
      return `元素 ${sourceId} 的文本内容已设置；${removedSourceIds.length} 个原后代元素已移除；HTML、CSS 与安全规则校验通过`;
    },
    setElementAttributes: async (sourceId, set, remove) => {
      if (!Object.keys(set).length && !remove.length) throw new Error('属性操作不能为空');
      const html = working['index.html'];
      const range = sourceElementRange(html, sourceId);
      const openingEnd = findTagEnd(html, range.start);
      const openingTag = html.slice(range.start, openingEnd + 1);
      const updatedTag = updateOpeningTagAttributes(openingTag, set, remove);
      const next = `${html.slice(0, range.start)}${updatedTag}${html.slice(openingEnd + 1)}`;
      validateHtml(next);
      working['index.html'] = next;
      refreshIndexes();
      return `元素 ${sourceId} 的属性已更新（设置 ${Object.keys(set).length} 项，删除 ${remove.length} 项）；HTML 与安全规则校验通过`;
    },
    insertElement: async (targetSourceId, position, fragmentHtml, options) => {
      const html = working['index.html'];
      const fragment = fragmentWithFreshSourceIds(html, fragmentHtml);
      const insertionHtml = options?.styleReferenceSourceId && !authorRuleMode
        ? applyFrozenReferenceStyles(
          fragment.html,
          fragment.rootSourceIds,
          html,
          options.styleReferenceSourceId
        )
        : fragment.html;
      const targetRange = sourceElementRange(html, targetSourceId);
      let insertionIndex: number;
      if (position === 'parentStart' || position === 'insideStart') {
        insertionIndex = findTagEnd(html, targetRange.start) + 1;
      } else if (position === 'parentEnd' || position === 'insideEnd') {
        insertionIndex = elementClosingTagStart(html, targetRange);
      } else {
        insertionIndex = position === 'before' ? targetRange.start : targetRange.end;
      }
      const next = `${html.slice(0, insertionIndex)}${insertionHtml}${html.slice(insertionIndex)}`;
      validateHtml(next);
      working['index.html'] = next;
      refreshIndexes();
      return `已在元素 ${targetSourceId} 的 ${position} 位置插入 ${fragment.rootSourceIds.length} 个顶层元素：${fragment.rootSourceIds.join(', ')}${options?.styleReferenceSourceId && !authorRuleMode ? `；已复制 ${options.styleReferenceSourceId} 的冻结计算样式作为布局参照` : ''}；HTML、结构与安全规则校验通过`;
    },
    wrapElement: async (sourceId, tagName, attributes) => {
      const html = working['index.html'];
      const range = sourceElementRange(html, sourceId);
      const wrapperSourceId = `source-${nextSourceNumber(html)}`;
      const openingTag = wrapperOpeningTag(tagName, wrapperSourceId, attributes);
      const outerHtml = html.slice(range.start, range.end);
      const wrapped = `${openingTag}${outerHtml}</${tagName}>`;
      const next = `${html.slice(0, range.start)}${wrapped}${html.slice(range.end)}`;
      validateHtml(next);
      working['index.html'] = next;
      refreshIndexes();
      return `元素 ${sourceId} 已由新容器 ${wrapperSourceId}<${tagName.toLowerCase()}> 包裹；HTML、结构与安全规则校验通过`;
    },
    unwrapElement: async sourceId => {
      const html = working['index.html'];
      const range = sourceElementRange(html, sourceId);
      const inner = sourceElementInnerRange(html, range);
      const innerHtml = html.slice(inner.start, inner.end);
      const next = `${html.slice(0, range.start)}${innerHtml}${html.slice(range.end)}`;
      validateHtml(next);
      working['index.html'] = next;
      working[editableStylePath] = withoutSourceScopedCss(working[editableStylePath], [sourceId]);
      validateCss(working[editableStylePath]);
      refreshIndexes();
      return `容器元素 ${sourceId} 已解除包裹，其原有子节点保留在原位置；HTML、CSS、结构与安全规则校验通过`;
    },
    removeElement: async sourceId => {
      const html = working['index.html'];
      const range = sourceElementRange(html, sourceId);
      const removedHtml = html.slice(range.start, range.end);
      const removedSourceIds = [...removedHtml.matchAll(
        /\bdata-ui-source-id\s*=\s*["']([^"']+)["']/gi
      )].map(match => match[1]!);
      const next = `${html.slice(0, range.start)}${html.slice(range.end)}`;
      validateHtml(next);
      working['index.html'] = next;
      working[editableStylePath] = withoutSourceScopedCss(working[editableStylePath], removedSourceIds);
      validateCss(working[editableStylePath]);
      refreshIndexes();
      return `元素 ${sourceId} 已完整删除；其 ${Math.max(0, removedSourceIds.length - 1)} 个后代节点及对应 sourceId 专属样式已同步移除；HTML、CSS、结构与安全规则校验通过`;
    },
    reorderChildren: async (parentSourceId, orderedSourceIds) => {
      if (new Set(orderedSourceIds).size !== orderedSourceIds.length) throw new Error('排序列表包含重复 sourceId');
      const html = working['index.html'];
      const parentRange = sourceElementRange(html, parentSourceId);
      const parentInner = sourceElementInnerRange(html, parentRange);
      const outline = JSON.parse(working['outline.json']) as {
        nodes: Array<{ sourceId: string; childrenSourceIds: string[] }>;
      };
      const directChildren = outline.nodes.find(node => node.sourceId === parentSourceId)?.childrenSourceIds ?? [];
      if (
        directChildren.length !== orderedSourceIds.length
        || directChildren.some(sourceId => !orderedSourceIds.includes(sourceId))
      ) {
        throw new Error(`orderedSourceIds 必须恰好包含父元素 ${parentSourceId} 的全部直接 source 子节点`);
      }
      const ranges = directChildren
        .map(sourceId => ({ sourceId, ...sourceElementRange(html, sourceId) }))
        .sort((left, right) => left.start - right.start);
      const outerById = new Map(ranges.map(range => [range.sourceId, html.slice(range.start, range.end)]));
      const gaps: string[] = [];
      let cursor = parentInner.start;
      for (const range of ranges) {
        gaps.push(html.slice(cursor, range.start));
        cursor = range.end;
      }
      gaps.push(html.slice(cursor, parentInner.end));
      const reorderedInner = orderedSourceIds
        .map((sourceId, index) => `${gaps[index]}${outerById.get(sourceId)!}`)
        .join('') + gaps.at(-1)!;
      const next = `${html.slice(0, parentInner.start)}${reorderedInner}${html.slice(parentInner.end)}`;
      if (next === html) throw new Error('子节点已经是指定顺序');
      validateHtml(next);
      working['index.html'] = next;
      refreshIndexes();
      return `父元素 ${parentSourceId} 的 ${orderedSourceIds.length} 个直接子节点已按指定顺序重排；HTML、结构与安全规则校验通过`;
    },
    moveElement: async (sourceId, position, targetSourceId) => {
      const html = working['index.html'];
      const sourceRange = sourceElementRange(html, sourceId);
      const sourceAncestry = sourceElementAncestry(html, sourceId);
      const parent = sourceAncestry.at(-2);
      const outerHtml = html.slice(sourceRange.start, sourceRange.end);
      const withoutSource = `${html.slice(0, sourceRange.start)}${html.slice(sourceRange.end)}`;
      let insertionIndex: number;
      let destination: string;

      if (position === 'insideStart' || position === 'insideEnd') {
        if (!targetSourceId) throw new Error(`${position} 移动必须提供 targetSourceId`);
        const targetRange = sourceElementRange(withoutSource, targetSourceId);
        insertionIndex = position === 'insideStart'
          ? findTagEnd(withoutSource, targetRange.start) + 1
          : elementClosingTagStart(withoutSource, targetRange);
        destination = `目标容器 ${targetSourceId} 的${position === 'insideStart' ? '开头' : '末尾'}`;
      } else if (position === 'parentStart' || position === 'parentEnd') {
        if (!parent) throw new Error(`元素 ${sourceId} 没有可编辑的父容器`);
        const parentRange = sourceElementRange(withoutSource, parent.sourceId);
        if (position === 'parentStart') {
          insertionIndex = findTagEnd(withoutSource, parentRange.start) + 1;
        } else {
          insertionIndex = elementClosingTagStart(withoutSource, parentRange);
        }
        destination = `父容器 ${parent.sourceId} 的${position === 'parentStart' ? '开头' : '末尾'}`;
      } else {
        if (!targetSourceId) throw new Error(`${position} 移动必须提供 targetSourceId`);
        if (targetSourceId === sourceId) throw new Error('不能相对于元素自身移动');
        const targetRange = sourceElementRange(withoutSource, targetSourceId);
        insertionIndex = position === 'before' ? targetRange.start : targetRange.end;
        destination = `元素 ${targetSourceId} 的${position === 'before' ? '前面' : '后面'}`;
      }

      const next = `${withoutSource.slice(0, insertionIndex)}${outerHtml}${withoutSource.slice(insertionIndex)}`;
      if (next === html) throw new Error(`元素 ${sourceId} 已位于指定位置`);
      validateHtml(next);
      working['index.html'] = next;
      refreshIndexes();
      return `元素 ${sourceId} 已完整移动到${destination}；原始结构和样式保持不变；HTML 与安全规则校验通过`;
    },
    cloneElement: async (templateSourceId, position, targetSourceId, replacements = []) => {
      const html = working['index.html'];
      const templateRange = sourceElementRange(html, templateSourceId);
      const templateAncestry = sourceElementAncestry(html, templateSourceId);
      const templateParent = templateAncestry.at(-2);
      let clonedHtml = html.slice(templateRange.start, templateRange.end);

      for (const replacement of replacements) {
        const occurrences = countOccurrences(clonedHtml, replacement.search);
        if (occurrences !== 1) {
          throw new Error(occurrences === 0
            ? `模板元素 ${templateSourceId} 中不存在替换原文“${replacement.search}”`
            : `替换原文“${replacement.search}”在模板元素中出现 ${occurrences} 次，请提供更完整的唯一上下文`);
        }
        clonedHtml = clonedHtml.replace(replacement.search, replacement.replace);
      }

      const clone = cloneWithFreshSourceIds(html, clonedHtml);
      const clonedScopedCss = clonedSourceScopedCss(working[editableStylePath], clone.sourceIdMap);
      let base = html;
      let insertionIndex: number;
      let destination: string;

      if (position === 'replace') {
        if (!targetSourceId) throw new Error('replace 克隆必须提供 targetSourceId');
        const targetRange = sourceElementRange(base, targetSourceId);
        base = `${base.slice(0, targetRange.start)}${base.slice(targetRange.end)}`;
        insertionIndex = targetRange.start;
        destination = `并替换元素 ${targetSourceId}`;
      } else if (position === 'insideStart' || position === 'insideEnd') {
        if (!targetSourceId) throw new Error(`${position} 克隆必须提供 targetSourceId`);
        const targetRange = sourceElementRange(base, targetSourceId);
        insertionIndex = position === 'insideStart'
          ? findTagEnd(base, targetRange.start) + 1
          : elementClosingTagStart(base, targetRange);
        destination = `到目标容器 ${targetSourceId} 的${position === 'insideStart' ? '开头' : '末尾'}`;
      } else if (position === 'parentStart' || position === 'parentEnd') {
        if (!templateParent) throw new Error(`模板元素 ${templateSourceId} 没有可编辑的父容器`);
        const parentRange = sourceElementRange(base, templateParent.sourceId);
        insertionIndex = position === 'parentStart'
          ? findTagEnd(base, parentRange.start) + 1
          : elementClosingTagStart(base, parentRange);
        destination = `到父容器 ${templateParent.sourceId} 的${position === 'parentStart' ? '开头' : '末尾'}`;
      } else {
        if (!targetSourceId) throw new Error(`${position} 克隆必须提供 targetSourceId`);
        const targetRange = sourceElementRange(base, targetSourceId);
        insertionIndex = position === 'before' ? targetRange.start : targetRange.end;
        destination = `到元素 ${targetSourceId} 的${position === 'before' ? '前面' : '后面'}`;
      }

      const next = `${base.slice(0, insertionIndex)}${clone.html}${base.slice(insertionIndex)}`;
      validateHtml(next);
      working['index.html'] = next;
      working[editableStylePath] = [
        working[editableStylePath].trimEnd(),
        clonedScopedCss
      ].filter(Boolean).join('\n') + '\n';
      validateCss(working[editableStylePath]);
      refreshIndexes();
      return `已从模板 ${templateSourceId} 完整克隆元素 ${clone.rootSourceId}${destination}；结构与${authorRuleMode ? '可编辑覆盖样式' : '冻结样式'}已同步；HTML、CSS 与安全规则校验通过`;
    },
    applyDomOperations: async operations => {
      if (!Array.isArray(operations)) throw new Error('apply_dom_operations 缺少 operations 数组；本次未执行写入');
      if (!operations.length || operations.length > 20) throw new Error('批量 DOM 操作必须包含 1-20 项');
      const before = { ...working };
      const results: string[] = [];
      try {
        for (const operation of operations) {
          const result = operation.kind === 'setText'
            ? await toolset.setElementText(operation.sourceId, operation.text)
            : operation.kind === 'setAttributes'
              ? await toolset.setElementAttributes(operation.sourceId, operation.set, operation.remove)
              : operation.kind === 'insert'
                ? await toolset.insertElement(operation.targetSourceId, operation.position, operation.html)
                : operation.kind === 'wrap'
                  ? await toolset.wrapElement(operation.sourceId, operation.tagName, operation.attributes)
                  : operation.kind === 'unwrap'
                    ? await toolset.unwrapElement(operation.sourceId)
                    : operation.kind === 'remove'
                      ? await toolset.removeElement(operation.sourceId)
                      : operation.kind === 'move'
                        ? await toolset.moveElement(operation.sourceId, operation.position, operation.targetSourceId)
                        : operation.kind === 'clone'
                          ? await toolset.cloneElement(
                            operation.templateSourceId,
                            operation.position,
                            operation.targetSourceId,
                            operation.replacements
                          )
                          : await toolset.reorderChildren(
                            operation.parentSourceId,
                            operation.orderedSourceIds
                          );
          results.push(result);
        }
        validateWorking();
        return `已原子应用 ${operations.length} 项 DOM 操作并完成统一校验：\n${results.map((result, index) => `${index + 1}. ${result}`).join('\n')}`;
      } catch (error) {
        working = before;
        throw new Error(`批量 DOM 操作已全部回滚：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    validate: async () => validateWorking(),
    commit: async (summary, options = {}) => {
      if (working['index.html'] === original['index.html'] && working[editableStylePath] === original[editableStylePath]
        && working['module.jsx'] === original['module.jsx']) {
        if (!options.allowNoChanges) throw new Error('Agent 没有对静态源码产生修改');
        validateWorking();
        const revision = session.currentRevision();
        close();
        return { revision, changed: false };
      }
      validateWorking();
      const revision = session.commit(working, summary);
      close();
      return { revision, changed: true };
    },
    rollback: async () => close()
  };
  return toolset;
}

function assertEditablePath(path: string, editableStylePath: 'snapshot.css' | 'author-overrides.css') {
  if (path !== 'index.html' && path !== editableStylePath && path !== 'module.jsx') {
    throw new Error(`源码 Agent 当前只能修改 index.html、module.jsx 或 ${editableStylePath}，拒绝路径 ${path}`);
  }
}
function assertReadablePath(path: string): asserts path is WorkspaceFile {
  if (!WORKSPACE_FILES.includes(path as WorkspaceFile)) {
    throw new Error(`源码 Agent 不能访问工作区文件 ${path}`);
  }
}
