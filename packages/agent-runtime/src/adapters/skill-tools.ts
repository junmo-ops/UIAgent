import { createTool, type AgentTool, type AgentToolContext } from '../../vendor/ui-agent-runtime/index.js';
import type { SkillSession } from '../core/skill-port';

export function skillTools(session: SkillSession, record?: (name: string, input: unknown, context: AgentToolContext, result?: string, error?: string) => void): AgentTool<any, any>[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (input: any, context: AgentToolContext) => string | Promise<string>) => createTool({
    name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    execute: async (input: any, context: AgentToolContext) => {
      try { const result = await execute(input, context); record?.(name, input, context, result); return result; }
      catch (error) { record?.(name, input, context, undefined, error instanceof Error ? error.message : '技能执行失败'); throw error; }
    }
  });
  return [
    tool('load_skill', '按用途选择一个已发布技能并加载正文。本轮只能使用一个主技能。', { id: { type: 'string' } }, ['id'], input => session.load(input.id)),
    tool('read_skill_resource', '读取已加载技能包内的参考文档或文本模板，路径相对于技能根目录。', { path: { type: 'string' } }, ['path'], input => session.read(input.path)),
    tool('run_skill_script', '执行已加载技能声明的 Node.js/Python 脚本。args 为 JSON 参数，inputs 为明确提供的 UTF-8 输入文件；返回退出码、日志及生成的文本文件。不会直接修改副本，须用现有源码工具应用候选改动并校验。', {
      script: { type: 'string' }, args: { type: 'object', additionalProperties: true },
      inputs: { type: 'array', maxItems: 20, items: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'], additionalProperties: false } }
    }, ['script', 'args', 'inputs'], (input, context) => session.run(input.script, input.args, input.inputs, context.signal))
  ];
}
