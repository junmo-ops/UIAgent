import type { AgentRunResult, AgentTool, AgentToolContext } from '@cline/sdk';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type SourceTurnRequest } from '@ui-agent/contracts';
import type { CodingAgentEvent, CodingWorkspaceTools } from './coding-agent-port';
import {
  ClineCodingAgentAdapter,
  clineCodingAgentFromEnvironment,
  type ClineAgentFactoryInput
} from './cline-coding-agent-adapter';

const request: SourceTurnRequest = {
  protocolVersion: PROTOCOL_VERSION,
  editSessionId: 'session',
  turnId: 'turn',
  traceId: 'trace',
  instruction: '把查询改成确定',
  sourceId: 'source-0'
};

function context(iteration: number): AgentToolContext {
  return { agentId: 'test-agent', iteration };
}

function result(iterations: number, status: AgentRunResult['status'] = 'completed'): AgentRunResult {
  return {
    agentId: 'test-agent',
    runId: 'test-run',
    status,
    iterations,
    outputText: '',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  };
}

function findTool<TInput>(
  config: ClineAgentFactoryInput,
  name: string
): AgentTool<TInput, string> {
  const tool = config.tools.find(item => item.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool as AgentTool<TInput, string>;
}

function workspaceTools() {
  let html = '<button data-ui-source-id="source-0">查询</button>';
  let css = '';
  let committed = false;
  let rolledBack = false;
  const structuralOperations: string[] = [];
  const tools: CodingWorkspaceTools = {
    listFiles: async () => [{ path: 'index.html', chars: html.length }],
    searchText: async query => html.includes(query) ? html : '没有找到',
    readFile: async () => html,
    inspectElement: async () => html,
    readStyleRule: async className => `.${className}{width:160px}`,
    replaceText: async (_path, search, replace) => {
      html = html.replace(search, replace);
      return '替换成功';
    },
    applyPatch: async (path, edits) => {
      for (const edit of edits) {
        if (path === 'snapshot.css' && edit.kind === 'insert' && edit.position === 'end') {
          css = `${css}${edit.text}`;
        } else if (edit.kind === 'replace') {
          html = html.replace(edit.search, edit.replace);
        } else if (edit.position === 'start') {
          html = `${edit.text}${html}`;
        } else if (edit.position === 'end') {
          html = `${html}${edit.text}`;
        }
      }
      return 'Patch 成功';
    },
    replaceInElement: async (_sourceId, search, replace) => {
      html = html.replace(search, replace);
      return '元素内替换成功';
    },
    moveElement: async sourceId => {
      structuralOperations.push(`move:${sourceId}`);
      return '移动成功';
    },
    cloneElement: async templateSourceId => {
      structuralOperations.push(`clone:${templateSourceId}`);
      return '克隆成功';
    },
    validate: async () => '工作区校验通过',
    commit: async () => {
      committed = true;
      return 2;
    },
    rollback: async () => {
      rolledBack = true;
    }
  };
  return {
    tools,
    state: () => ({ html, css, committed, rolledBack, structuralOperations })
  };
}

describe('ClineCodingAgentAdapter', () => {
  it('exposes only restricted source tools and completes through finish', async () => {
    const workspace = workspaceTools();
    let configuredTools: string[] = [];
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        run: async () => {
          configuredTools = config.tools.map(tool => tool.name);
          await findTool<Record<string, never>>(config, 'list_files').execute({}, context(1));
          await findTool<{ sourceId: string }>(config, 'inspect_element').execute(
            { sourceId: 'source-0' },
            context(2)
          );
          await findTool<{ path: string; search: string; replace: string }>(config, 'replace_text').execute(
            { path: 'index.html', search: '查询', replace: '确定' },
            context(3)
          );
          await findTool<{ summary: string }>(config, 'finish').execute(
            { summary: '已修改按钮文案' },
            context(4)
          );
          return result(4);
        }
      })
    });
    const events: CodingAgentEvent[] = [];
    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspace.tools, event => events.push(event));

    expect(configuredTools).toEqual([
      'list_files',
      'search_text',
      'read_file',
      'inspect_element',
      'read_style_rule',
      'replace_text',
      'apply_patch',
      'replace_in_element',
      'move_element',
      'clone_element',
      'validate_workspace',
      'finish',
      'clarify'
    ]);
    expect(configuredTools).not.toContain('shell');
    expect(configuredTools).not.toContain('browser');
    expect(run.response).toMatchObject({
      kind: 'completed',
      revision: 2,
      modelCalls: 4,
      toolCalls: 3
    });
    expect(run.checkpoint).toMatchObject({
      adapterId: 'cline-sdk',
      status: 'completed',
      modelCalls: 4,
      toolCalls: 3,
      stepCount: 4,
      lastAction: 'finish'
    });
    expect(run.steps.map(step => step.action)).toEqual([
      'list_files',
      'inspect_element',
      'replace_text',
      'finish'
    ]);
    expect(workspace.state()).toMatchObject({
      html: expect.stringContaining('确定'),
      committed: true,
      rolledBack: false
    });
    expect(events.at(-1)?.type).toBe('coding-agent.turn.completed');
  });

  it('rolls back when the runtime ends without finish or clarify', async () => {
    const workspace = workspaceTools();
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: () => ({ run: async () => result(1) })
    });
    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspace.tools);

    expect(run.response).toMatchObject({
      kind: 'failed',
      code: 'CLINE_AGENT_ERROR'
    });
    expect(run.checkpoint.status).toBe('failed');
    expect(workspace.state().rolledBack).toBe(true);
  });

  it('bridges an end-of-file patch for generated CSS', async () => {
    const workspace = workspaceTools();
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        run: async () => {
          await findTool<{
            path: string;
            edits: Array<{ kind: 'insert'; position: 'end'; text: string }>;
          }>(config, 'apply_patch').execute({
            path: 'snapshot.css',
            edits: [{ kind: 'insert', position: 'end', text: '\n.dropdown{position:absolute}' }]
          }, context(1));
          await findTool<{ summary: string }>(config, 'finish').execute(
            { summary: '已增加下拉样式' },
            context(2)
          );
          return result(2);
        }
      })
    });
    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspace.tools);

    expect(run.response.kind).toBe('completed');
    expect(workspace.state().css).toContain('.dropdown{position:absolute}');
  });

  it('uses compact style lookup and structural movement without rebuilding HTML', async () => {
    const workspace = workspaceTools();
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        run: async () => {
          await findTool<{ className: string }>(config, 'read_style_rule').execute(
            { className: 'ui-snapshot-style-38' },
            context(1)
          );
          await findTool<{
            sourceId: string;
            position: 'before';
            targetSourceId: string;
          }>(config, 'move_element').execute({
            sourceId: 'source-130',
            position: 'before',
            targetSourceId: 'source-49'
          }, context(2));
          await findTool<{ summary: string }>(config, 'finish').execute(
            { summary: '已移动筛选项' },
            context(3)
          );
          return result(3);
        }
      })
    });
    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspace.tools);

    expect(run.response.kind).toBe('completed');
    expect(run.steps.map(step => step.action)).toEqual([
      'read_style_rule',
      'move_element',
      'finish'
    ]);
    expect(workspace.state().structuralOperations).toEqual(['move:source-130']);
  });

  it('uses clarify as a terminal action and rolls back safely', async () => {
    const workspace = workspaceTools();
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        run: async () => {
          await findTool<{ question: string }>(config, 'clarify').execute(
            { question: '请说明要修改哪个按钮' },
            context(1)
          );
          return result(1);
        }
      })
    });
    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspace.tools);

    expect(run.response).toEqual({
      kind: 'clarification',
      question: '请说明要修改哪个按钮'
    });
    expect(run.checkpoint).toMatchObject({
      status: 'clarification',
      toolCalls: 0,
      lastAction: 'clarify'
    });
    expect(workspace.state().rolledBack).toBe(true);
  });

  it('validates environment configuration without contacting a model', () => {
    expect(() => clineCodingAgentFromEnvironment({
      CODING_AGENT_ADAPTER: 'cline',
      MODEL_MODE: 'mock'
    })).toThrow('MODEL_MODE=remote');
    expect(clineCodingAgentFromEnvironment({
      MODEL_MODE: 'remote',
      MODEL_BASE_URL: 'https://example.test',
      MODEL_API_KEY: 'test-key',
      MODEL_NAME: 'test-model',
      CLINE_MAX_ITERATIONS: '12'
    }).adapterId).toBe('cline-sdk');
  });
});
