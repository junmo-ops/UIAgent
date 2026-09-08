import type { AgentRunResult, AgentTool, AgentToolContext } from '../../vendor/ui-agent-runtime/index.js';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type SourceTurnRequest } from '@ui-agent/contracts';
import type { CodingAgentEvent, CodingWorkspaceTools } from '../core/coding-agent-port';
import type { RequirementReview } from '../source-editing/requirement-review';

const completedReview: { requirementReview: RequirementReview } = { requirementReview: {
  originalRequestReviewed: true, missingRequirements: [], checks: [
    { constraintIndex: 1, status: 'implemented', evidence: '测试工作区目标节点实现' },
    { constraintIndex: 2, status: 'implemented', evidence: '测试工作区仅对目标应用修改' }
  ]
} };
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
): AgentTool<TInput & Partial<typeof completedReview>, string> {
  const tool = config.tools.find(item => item.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool as AgentTool<TInput, string>;
}

async function declareIntent(config: ClineAgentFactoryInput, iteration: number): Promise<void> {
  await findTool<{
    summary: string;
    relevantSourceIds: string[];
    verificationSourceIds: string[];
    visualConstraints: string[];
    renderConstraintIndexes: number[];
    ambiguityAssessment: string;
  }>(config, 'declare_intent').execute({
    summary: '按用户要求修改选中元素',
    relevantSourceIds: ['source-0'],
    verificationSourceIds: ['source-0'],
    visualConstraints: ['目标元素可见且未被裁切', '保持无关结构和样式不变'],
    renderConstraintIndexes: [1],
    ambiguityAssessment: '目标元素和修改内容已经明确'
  }, context(iteration));
}

function workspaceTools(commitResult = { revision: 2, changed: true }) {
  let html = '<button data-ui-source-id="source-0">查询</button>';
  let css = '';
  let committed = false;
  let rolledBack = false;
  const structuralOperations: string[] = [];
  const tools: CodingWorkspaceTools = {
    listFiles: async () => [{ path: 'index.html', chars: html.length }],
    queryWorkspaceStructure: async query => `结构查询：${query} -> source-0<button>`,
    searchText: async query => html.includes(query) ? html : '没有找到',
    readFile: async () => html,
    inspectElement: async () => html,
    queryStyleSymbols: async symbols => symbols.map(symbol => `${symbol}: 未找到`).join('\n'),
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
    setElementText: async (_sourceId, text) => { html = text; return '文本设置成功'; },
    setElementAttributes: async () => '属性设置成功',
    insertElement: async (_targetSourceId, _position, fragment) => { html += fragment; return '插入成功'; },
    wrapElement: async () => '包裹成功',
    unwrapElement: async () => '解包成功',
    removeElement: async sourceId => {
      html = '';
      structuralOperations.push(`remove:${sourceId}`);
      return '删除成功';
    },
    reorderChildren: async () => '排序成功',
    applyDomOperations: async operations => `批量执行 ${operations.length} 项成功`,
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
      return commitResult;
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
  it('aborts an active run and rolls back uncommitted workspace changes', async () => {
    const workspace = workspaceTools();
    let abort: (() => void) | undefined;
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: () => ({
        run: () => new Promise<AgentRunResult>((_resolve, reject) => {
          abort = () => reject(new Error('request aborted'));
        }),
        abort: () => abort?.()
      })
    });
    const controller = new AbortController();
    const running = adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspace.tools, undefined, controller.signal);

    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();

    await expect(running).resolves.toMatchObject({
      response: { kind: 'cancelled' },
      checkpoint: { status: 'cancelled' }
    });
    expect(workspace.state()).toMatchObject({ committed: false, rolledBack: true });
  });

  it('blocks source tools until the model declares a resolved intent', async () => {
    const workspace = workspaceTools();
    let gateError = '';
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        run: async () => {
          try {
            await findTool<{ path: string; search: string; replace: string }>(config, 'replace_text').execute(
              { path: 'index.html', search: '查询', replace: '错误' },
              context(1)
            );
          } catch (error) {
            gateError = error instanceof Error ? error.message : String(error);
          }
          await findTool<{ question: string }>(config, 'clarify').execute(
            { question: '当前仍有关键歧义，请补充预期结果' },
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

    expect(gateError).toContain('declare_intent');
    expect(run.response.kind).toBe('clarification');
    expect(workspace.state().html).toContain('查询');
  });

  it('keeps source tools visible and rejects writes at execution time until intent is declared', async () => {
    const workspace = workspaceTools();
    let configuredTools: string[] = [];
    let configuredMaxIterations = 0;
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        run: async () => {
          configuredTools = config.tools.map(tool => tool.name);
          configuredMaxIterations = config.maxIterations;
          const replaceTool = findTool<{ path: string; search: string; replace: string }>(config, 'replace_text');
          expect(replaceTool.isAvailable).toBeUndefined();
          expect(findTool<Record<string, never>>(config, 'list_files').isAvailable).toBeUndefined();
          await findTool<Record<string, never>>(config, 'list_files').execute({}, context(1));
          await findTool<{ sourceId: string }>(config, 'inspect_element').execute(
            { sourceId: 'source-0' },
            context(2)
          );
          await declareIntent(config, 3);
          await replaceTool.execute(
            { path: 'index.html', search: '查询', replace: '确定' },
            context(4)
          );
          await findTool<{ summary: string }>(config, 'finish').execute(
            { summary: '已修改按钮文案', ...completedReview },
            context(5)
          );
          return result(5);
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
      'declare_intent',
      'list_files',
      'query_workspace_structure',
      'search_text',
      'read_file',
      'inspect_element',
      'inspect_elements',
      'query_style_symbols',
      'read_style_rule',
      'read_style_rules',
      'replace_text',
      'apply_patch',
      'replace_in_element',
      'set_element_text',
      'set_element_attributes',
      'insert_element',
      'wrap_element',
      'unwrap_element',
      'remove_element',
      'reorder_children',
      'apply_dom_operations',
      'move_element',
      'clone_element',
      'validate_spatial_scope',
      'validate_workspace',
      'finish',
      'clarify'
    ]);
    expect(configuredTools).not.toContain('shell');
    expect(configuredTools).not.toContain('browser');
    expect(configuredMaxIterations).toBe(45);
    expect(run.response).toMatchObject({
      kind: 'completed',
      revision: 2,
      modelCalls: 5,
      toolCalls: 4
    });
    expect(run.checkpoint).toMatchObject({
      adapterId: 'cline-sdk',
      status: 'completed',
      modelCalls: 5,
      toolCalls: 4,
      stepCount: 5,
      lastAction: 'finish'
    });
    expect(run.steps.map(step => step.action)).toEqual([
      'list_files',
      'inspect_element',
      'declare_intent',
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

  it('requires compact inspection before a source can be expanded and bounds batch inspection output', async () => {
    const workspace = workspaceTools();
    workspace.tools.inspectElement = async () => 'x'.repeat(5_000);
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        run: async () => {
          const inspect = findTool<{ sourceId: string; detail?: 'compact' | 'full' }>(config, 'inspect_element');
          const firstFull = await inspect.execute({ sourceId: 'source-0', detail: 'full' }, context(1));
          expect(firstFull).toContain('[展开条件]');
          expect(await inspect.execute({ sourceId: 'source-0' }, context(2))).toHaveLength(5_000);
          expect(await inspect.execute({ sourceId: 'source-0', detail: 'full' }, context(3))).toHaveLength(5_000);

          const batch = await findTool<{ sourceIds: string[] }>(config, 'inspect_elements').execute({
            sourceIds: ['source-1', 'source-2', 'source-3']
          }, context(4));
          expect(batch).toContain('[批量检查已按总预算截断]');
          expect(batch.length).toBeLessThan(13_000);
          await declareIntent(config, 5);
          await findTool<{
            summary: string;
            outcome: 'already_satisfied';
            evidence: string;
          }>(config, 'finish').execute({
            summary: '测试完成',
            ...completedReview,
            outcome: 'already_satisfied',
            evidence: '已对紧凑、展开和批量读取预算进行源码工具验证。'
          }, context(6));
          return result(6);
        }
      })
    });

    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspace.tools);
    if (run.response.kind === 'failed') throw new Error(run.response.message);
    expect(run).toMatchObject({ response: { kind: 'completed' } });
  });

  it('completes normally when verified source already satisfies the request', async () => {
    const workspace = workspaceTools({ revision: 7, changed: false });
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        run: async () => {
          await findTool<Record<string, never>>(config, 'list_files').execute({}, context(1));
          await findTool<{ sourceId: string }>(config, 'inspect_element').execute(
            { sourceId: 'source-0' },
            context(2)
          );
          await declareIntent(config, 3);
          await findTool<{
            summary: string;
            outcome: 'already_satisfied';
            evidence: string;
          }>(config, 'finish').execute({
            summary: '按钮及选项菜单已经存在',
            ...completedReview,
            outcome: 'already_satisfied',
            evidence: '已读取当前按钮、菜单选项和声明式交互结构，并完成工作区校验。'
          }, context(4));
          return result(4);
        }
      })
    });

    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspace.tools);

    expect(run.response).toMatchObject({
      kind: 'completed',
      revision: 7,
      unchanged: true,
      summary: expect.stringContaining('无需重复修改')
    });
    expect(run.checkpoint.status).toBe('completed');
    expect(workspace.state()).toMatchObject({ committed: true, rolledBack: false });
  });

  it('separates HTML and CSS read budgets and permits inspection after a write', async () => {
    const workspace = workspaceTools();
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test', apiKey: 'test-key', modelName: 'test-model',
      factory: config => ({ run: async () => {
        for (let i = 0; i < 4; i++) {
          await findTool<any>(config, 'search_text').execute({ path: 'index.html', query: String(i) }, context(1));
        }
        expect(await findTool<any>(config, 'search_text').execute({ path: 'author.css', query: 'button' }, context(2)))
          .not.toContain('读取预算');
        for (let i = 0; i < 3; i++) {
          await findTool<any>(config, 'inspect_element').execute({ sourceId: 'source-' + i }, context(3));
        }
        await declareIntent(config, 4);
        await findTool<any>(config, 'replace_text').execute({ path: 'index.html', search: '查询', replace: '确定' }, context(5));
        expect(await findTool<any>(config, 'inspect_element').execute({ sourceId: 'source-0' }, context(6))).toContain('确定');
        await findTool<any>(config, 'finish').execute({ summary: '完成', ...completedReview }, context(7));
        return result(7);
      } })
    });
    const run = await adapter.run({ workspaceId: '11111111-1111-4111-8111-111111111111', request, conversation: [] }, workspace.tools);
    expect(run.response.kind).toBe('completed');
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

  it('returns a useful message when a provider HTTP error has an empty message', async () => {
    const workspace = workspaceTools();
    const error = Object.assign(new Error(''), { statusCode: 433 });
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test', apiKey: 'test-key', modelName: 'test-model',
      factory: () => ({ run: async () => ({ ...result(1, 'failed'), error }) })
    });
    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111', request, conversation: []
    }, workspace.tools);
    expect(run.response).toMatchObject({ kind: 'failed', message: '模型服务请求失败（HTTP 433）' });
  });

  it('bridges an end-of-file patch for generated CSS', async () => {
    const workspace = workspaceTools();
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
        modelName: 'test-model',
      factory: config => ({
        run: async () => {
          await declareIntent(config, 1);
          await findTool<{
            path: string;
            edits: Array<{ kind: 'insert'; position: 'end'; text: string }>;
          }>(config, 'apply_patch').execute({
            path: 'snapshot.css',
            edits: [{ kind: 'insert', position: 'end', text: '\n.dropdown{position:absolute}' }]
          }, context(2));
          await findTool<{ summary: string }>(config, 'finish').execute(
            { summary: '已增加下拉样式', ...completedReview },
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
          await declareIntent(config, 2);
          await findTool<{
            sourceId: string;
            position: 'before';
            targetSourceId: string;
          }>(config, 'move_element').execute({
            sourceId: 'source-130',
            position: 'before',
            targetSourceId: 'source-49'
          }, context(3));
          await findTool<{ summary: string }>(config, 'finish').execute(
            { summary: '已移动筛选项', ...completedReview },
            context(4)
          );
          return result(4);
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
      'declare_intent',
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
          await findTool<{
            question: string;
            options: Array<{ id: string; label: string; description?: string }>;
          }>(config, 'clarify').execute(
            {
              question: '请说明要修改哪个按钮',
              options: [
                { id: 'primary', label: '主按钮', description: '修改当前区域的主要操作' },
                { id: 'secondary', label: '次按钮', description: '修改辅助操作' }
              ]
            },
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
      clarificationId: 'turn',
      question: '请说明要修改哪个按钮',
      options: [
        { id: 'primary', label: '主按钮', description: '修改当前区域的主要操作' },
        { id: 'secondary', label: '次按钮', description: '修改辅助操作' }
      ],
      allowFreeText: true
    });
    expect(run.checkpoint).toMatchObject({
      status: 'clarification',
      toolCalls: 0,
      lastAction: 'clarify'
    });
    expect(workspace.state().rolledBack).toBe(true);
  });

  it('allows targeted inspection in the final window with a completion reminder', async () => {
    const workspace = workspaceTools();
    let inspected = 0;
    workspace.tools.inspectElement = async () => {
      inspected += 1;
      return '目标当前源码';
    };
    let budgetMessage = '';
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      maxIterations: 6,
      factory: config => ({
        run: async () => {
          expect(config.systemPrompt).toContain('从第 4 轮起必须停止扩展读取');
          budgetMessage = await findTool<{ sourceId: string }>(config, 'inspect_element').execute(
            { sourceId: 'source-0' },
            context(4)
          );
          await findTool<{ question: string }>(config, 'clarify').execute(
            { question: '当前范围过大，请拆分后重试' },
            context(5)
          );
          return result(5);
        }
      })
    });

    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspace.tools);

    expect(budgetMessage).toContain('停止扩展范围');
    expect(inspected).toBe(1);
    expect(run.response.kind).toBe('clarification');
    expect(workspace.state().rolledBack).toBe(true);
  });

  it('requires new modules to validate against the selected spatial container', async () => {
    const workspace = workspaceTools();
    workspace.tools.inspectElement = async sourceId => sourceId === 'source-9'
      ? '结构路径: source-0<button> > source-9<span>\ncompactHtml: <span data-ui-source-id="source-9">提示</span>'
      : '结构路径: source-0<button>\ncompactHtml: <button data-ui-source-id="source-0">查询</button>';
    let prematureFinishError = '';
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        run: async () => {
          await declareIntent(config, 1);
          await findTool<{ path: string; search: string; replace: string }>(config, 'replace_text').execute({
            path: 'index.html',
            search: '<button data-ui-source-id="source-0">查询</button>',
            replace: '<button data-ui-source-id="source-0">查询<span data-ui-source-id="source-9">提示</span></button>'
          }, context(2));
          try {
            await findTool<{ summary: string }>(config, 'finish').execute(
              { summary: '新增提示', ...completedReview },
              context(3)
            );
          } catch (error) {
            prematureFinishError = error instanceof Error ? error.message : String(error);
          }
          await findTool<{
            scope: 'selected-context';
            containerSourceId: string;
            createdSourceIds: string[];
            reason: string;
          }>(config, 'validate_spatial_scope').execute({
            scope: 'selected-context',
            containerSourceId: 'source-0',
            createdSourceIds: ['source-9'],
            reason: '提示位于选中按钮内部'
          }, context(4));
          await findTool<{ summary: string }>(config, 'finish').execute(
            { summary: '已在选中按钮内新增提示', ...completedReview },
            context(5)
          );
          return result(5);
        }
      })
    });

    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request,
      conversation: []
    }, workspace.tools);

    expect(prematureFinishError).toContain('必须调用 validate_spatial_scope');
    expect(run.response.kind).toBe('completed');
    expect(workspace.state()).toMatchObject({ committed: true, rolledBack: false });
  });

  it('rejects global fixed positioning when the user only gave a local relative position', async () => {
    const workspace = workspaceTools();
    workspace.tools.inspectElement = async sourceId => sourceId === 'source-9'
      ? '结构路径: source-0<button> > source-9<span>'
      : '结构路径: source-0<button>';
    let spatialError = '';
    const adapter = new ClineCodingAgentAdapter({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelName: 'test-model',
      factory: config => ({
        run: async () => {
          await declareIntent(config, 1);
          await findTool<{ path: string; search: string; replace: string }>(config, 'replace_text').execute({
            path: 'index.html',
            search: '<button data-ui-source-id="source-0">查询</button>',
            replace: '<button data-ui-source-id="source-0">查询<span class="floating-tip" data-ui-source-id="source-9">提示</span></button>'
          }, context(2));
          await findTool<{
            path: string;
            edits: Array<{ kind: 'insert'; position: 'end'; text: string }>;
          }>(config, 'apply_patch').execute({
            path: 'snapshot.css',
            edits: [{ kind: 'insert', position: 'end', text: '.floating-tip{position:fixed;bottom:0}' }]
          }, context(3));
          try {
            await findTool<{
              scope: 'selected-context'; containerSourceId: string;
              createdSourceIds: string[]; positioningClassNames: string[]; reason: string;
            }>(config, 'validate_spatial_scope').execute({
              scope: 'selected-context',
              containerSourceId: 'source-0',
              createdSourceIds: ['source-9'],
              positioningClassNames: ['floating-tip'],
              reason: '用户说在按钮下方增加提示'
            }, context(4));
          } catch (error) {
            spatialError = error instanceof Error ? error.message : String(error);
          }
          await findTool<{ question: string }>(config, 'clarify').execute(
            { question: '请确认是否需要固定在浏览器视口底部' },
            context(5)
          );
          return result(5);
        }
      })
    });

    const run = await adapter.run({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      request: { ...request, instruction: '在按钮下方增加提示' },
      conversation: []
    }, workspace.tools);

    expect(spatialError).toContain('position:fixed');
    expect(run.response.kind).toBe('clarification');
    expect(workspace.state().rolledBack).toBe(true);
  });

  it('validates environment configuration without contacting a model', () => {
    expect(() => clineCodingAgentFromEnvironment({
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
