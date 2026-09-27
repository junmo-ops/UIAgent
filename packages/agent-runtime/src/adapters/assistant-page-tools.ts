import { z } from 'zod';
import { createTool, type AgentTool, type AgentToolContext } from '../../vendor/ui-agent-runtime/index.js';
import type { AssistantPageContext } from '../core/assistant-chat-port';

type Recorder = (name: string, input: unknown, context: AgentToolContext, result?: string, error?: string, blocked?: boolean) => void;

/** The model cannot choose another workspace or invoke a write operation. */
export function assistantPageTools(page: AssistantPageContext, record: Recorder): AgentTool<any, any>[] {
  let calls = 0;
  let remainingChars = 64_000;
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[],
    schema: z.ZodTypeAny, execute: (input: any, maxChars: number) => Promise<string>) => createTool({
    name, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    execute: async (input: any, context: AgentToolContext) => {
      try {
        context.signal?.throwIfAborted();
        if (calls >= 10 || remainingChars < 2000) {
          const result = JSON.stringify({ status: 'budget_exhausted', remainingCalls: Math.max(0, 10 - calls),
            remainingChars, message: '停止读取，根据已有证据回答；说明未覆盖范围，不推断缺失内容。' });
          record(name, input, context, result, undefined, true);
          return result;
        }
        const parsed = schema.parse(input);
        calls++;
        const limit = Math.min(12_000, remainingChars);
        // Reserve before awaiting: parallel tool calls must share one hard budget.
        remainingChars -= limit;
        let result: string;
        try { result = await execute(parsed, limit); }
        catch (error) { remainingChars += limit; throw error; }
        remainingChars += limit - Math.min(result.length, limit);
        const bounded = JSON.stringify({ workspaceId: page.workspaceId, revision: page.revision,
          evidence: 'saved-source-not-live-dom', truncated: result.length > limit,
          budget: { remainingCalls: 10 - calls, remainingChars },
          content: result.slice(0, limit) });
        record(name, input, context, bounded);
        return bounded;
      } catch (error) {
        record(name, input, context, undefined, error instanceof Error ? error.message : '读取失败');
        throw error;
      }
    }
  });
  const str = { type: 'string', minLength: 1, maxLength: 500 };
  const integer = { type: 'integer', minimum: 0 };
  const pagination = { offset: integer, limit: { type: 'integer', minimum: 1, maximum: 100 } };
  const pageSchema = { offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() };
  return [
    tool('get_page_directory', '内容整理或长页面阅读先查看区域目录与标题层级。返回 sourceId、parentRegion、parentHeading、标题级别、可读条目数和 readScope，不读取正文。由你根据需求选择区域，再用 read_page_region。目录分页完成不代表正文已读；没有语义区域时使用 get_page_overview。',
      { sourceId: str, ...pagination }, [],
      z.object({ sourceId: z.string().min(1).max(100).optional(), ...pageSchema }).strict(),
      (input, maxChars) => page.readContent({ ...input, view: 'directory', maxChars })),
    tool('get_page_overview', '了解整页内容的首选工具，无需猜搜索词。按源码顺序返回精简文本、标题、导航和控件及来源标识，不含 CSS。检查 coverage.hasMore，必要时用 nextOffset 续读；不是完整性或可见性证明。',
      pagination, [], z.object(pageSchema).strict(),
      (input, maxChars) => page.readContent({ ...input, maxChars })),
    tool('read_page_region', '读取选区或目录区域的内容。scope=subtree 读取 DOM 子树；目录中 readScope=section 的标题可用 scope=section 读取其标题章节（到同级/更高级标题或语义区域末尾）。分页 offset 相对该范围，按 nextOffset 续读。',
      { sourceId: str, scope: { type: 'string', enum: ['subtree', 'section'] }, ...pagination }, ['sourceId'],
      z.object({ sourceId: z.string().min(1).max(100), scope: z.enum(['subtree', 'section']).optional(), ...pageSchema }).strict(),
      (input, maxChars) => page.readContent({ ...input, maxChars })),
    tool('list_files', '列出当前副本可读取的源码文件及大小，不返回全文。', {}, [], z.object({}).strict(),
      async () => JSON.stringify(await page.tools.listFiles())),
    tool('query_workspace_structure', '按页面实际文本、标签、role、class 的字面词或 sourceId 匹配结构。这不是语义检索，不会将“导航”自动映射为 nav；整页理解先用 get_page_overview。',
      { query: str, selectedSourceId: str }, ['query'],
      z.object({ query: z.string().min(1).max(500), selectedSourceId: z.string().max(100).optional() }).strict(),
      input => page.tools.queryWorkspaceStructure(input.query, { selectedSourceId: input.selectedSourceId, limit: 6 })),
    tool('inspect_element', '仅在需要布局或样式实现线索时读取模块源码摘要和捕获布局。普通内容问答使用 read_page_region；不能证明当前可见性或业务接口行为。',
      { sourceId: str }, ['sourceId'], z.object({ sourceId: z.string().min(1).max(100) }).strict(),
      input => page.tools.inspectElement(input.sourceId)),
    tool('search_text', '在副本文件中搜索文本，返回命中片段和字符位置。动态模块实现可查 module.jsx。',
      { query: str, path: str }, ['query'],
      z.object({ query: z.string().min(1).max(500), path: z.string().min(1).max(100).optional() }).strict(),
      input => page.tools.searchText(input.query, input.path)),
    tool('read_file', '仅在需核对实现时按字符范围读取局部源码，默认最多 8000 字符；例如 module.jsx。普通页面概况使用 get_page_overview，不遍历 outline.json。',
      { path: str, startChar: integer, endChar: integer }, ['path'],
      z.object({ path: z.string().min(1).max(100), startChar: z.number().int().nonnegative().optional(),
        endChar: z.number().int().nonnegative().optional() }).strict(),
      input => {
        const start = input.startChar ?? 0;
        const end = input.endChar ?? start + 8000;
        if (end <= start || end - start > 10_000) throw new Error('单次读取范围必须在 1–10000 字符内');
        return page.tools.readFile(input.path, undefined, undefined, start, end);
      })
  ];
}
