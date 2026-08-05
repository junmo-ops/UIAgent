import { createOpenAI } from '@ai-sdk/openai';
import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from 'ai';
import {
  sourceAgentDecisionSchema,
  type SourceAgentDecision,
  type SourceTurnRequest,
  type SourceTurnResponse
} from '@ui-agent/contracts';
import { z, ZodError } from 'zod';
import type { CodingAgentStep, CodingWorkspaceTools } from '../core/coding-agent-port';
import { CONTROLLED_INTERACTION_INSTRUCTIONS } from './controlled-interaction-instructions';

export interface SourceFileTools extends CodingWorkspaceTools {}

interface SourceDecisionInput {
  request: SourceTurnRequest;
  files: Array<{ path: string; chars: number }>;
  conversation: SourceConversationTurn[];
  observations: Array<{ action: string; result: string }>;
}

export interface SourceConversationTurn {
  instruction: string;
  result: string;
}

export interface SourceAgentTraceStep extends CodingAgentStep {
  decision: SourceAgentDecision;
}

export interface SourceDecisionMaker {
  decide(input: SourceDecisionInput): Promise<SourceAgentDecision>;
}

const sourceRules = [
  '你是静态网页源码编辑 Agent。你只能通过给定的文件工具修改当前静态副本。',
  '页面只用于需求示意，不需要真实接口、脚本或业务提交。',
  '如果请求提供 selectedSourceId，系统会预先给出该元素的紧凑源码和原始文本片段；优先基于它完成修改。',
  '工作区包含 index.html、snapshot.css、outline.json 和 source-map.json。优先读取 outline.json 定位语义结构，再按需读取局部 HTML/CSS；outline.json 和 source-map.json 由系统维护，不要修改。',
  'index.html 只保存结构和稳定 class，冻结的计算样式位于 snapshot.css。修改视觉样式时先找到元素的 ui-snapshot-style-* class，再局部修改或新增 CSS 规则。',
  '先搜索与用户需求相关的文字或 data-ui-source-id；搜索结果会返回字符区间，再用 startChar/endChar 读取必要片段，不要读取整个大文件。',
  '修改已选元素的文案或局部属性时，优先使用 replaceInElement，把替换范围限制在 sourceId 对应元素内。',
  '移动已有元素时必须使用 moveElement，禁止用两次 replace 删除后重建元素。',
  '用户只说“移到顶部/底部/开头/末尾”且没有指定其他容器时，理解为原父容器的 parentStart/parentEnd，以保留原布局和滚动上下文；不要插到 </main> 或 </body> 附近。',
  '新增“与现有元素样式一致”的行、卡片、按钮或其他复杂组件时，必须使用 cloneElement 复制最相似的现有元素并通过 replacements 改内容；不要手写只有 class、没有内联计算样式的新结构。',
  '修复某元素使其与参考元素一致时，使用 cloneElement 的 replace 位置，以参考元素为 templateSourceId、待修复元素为 targetSourceId；不要额外新增一个元素。',
  '优先复用页面中已经存在的 HTML 结构和内联样式，保持组件尺寸、间距、边框、字体和布局一致。',
  '需要新增复杂结构时，复制最相似的现有结构，再修改文字、属性和静态状态。',
  'replace.search 必须是刚刚读取到的原文且足够唯一；不要猜测文件内容。',
  '不得添加 script、事件属性、远程资源、接口请求、表单 action 或 javascript: URL。',
  CONTROLLED_INTERACTION_INSTRUCTIONS,
  '每次替换后根据工具返回的校验结果决定继续修改或 finish。',
  '达到用户目标后立即 finish，不要做无关重构。',
  '只能返回指定 JSON，不要输出 Markdown 或解释。'
].join('\n');

const sourceDecisionJsonSchema = JSON.stringify(z.toJSONSchema(sourceAgentDecisionSchema));

class MockSourceDecisionMaker implements SourceDecisionMaker {
  async decide(input: SourceDecisionInput): Promise<SourceAgentDecision> {
    return {
      action: 'finish',
      summary: input.observations.length
        ? 'Mock 模式已完成静态源码处理'
        : 'Mock 模式未调用远程模型，静态副本保持原样'
    };
  }
}

class RemoteSourceDecisionMaker implements SourceDecisionMaker {
  private readonly provider;

  constructor(
    baseURL: string,
    apiKey: string,
    private readonly modelName: string,
    private readonly deepSeek: boolean
  ) {
    this.provider = createOpenAI({ name: deepSeek ? 'deepseek' : 'openai-compatible', baseURL, apiKey });
  }

  async decide(input: SourceDecisionInput): Promise<SourceAgentDecision> {
    const prompt = JSON.stringify({
      instruction: input.request.instruction,
      selectedSourceId: input.request.sourceId,
      conversation: input.conversation,
      files: input.files,
      observations: input.observations.slice(-10)
    });
    try {
      return await this.generate(prompt, undefined);
    } catch (error) {
      if (
        !NoObjectGeneratedError.isInstance(error)
        && !NoOutputGeneratedError.isInstance(error)
        && !(error instanceof ZodError)
      ) throw error;
      return this.generate(prompt, '上一次输出不是有效的工具决策 JSON。请严格按照 Schema 重新输出。');
    }
  }

  private async generate(prompt: string, repair?: string): Promise<SourceAgentDecision> {
    const system = [
      sourceRules,
      `JSON Schema：${sourceDecisionJsonSchema}`,
      ...(repair ? [repair] : [])
    ].join('\n');
    const result = await generateText({
      model: this.provider.chat(this.modelName),
      output: this.deepSeek
        ? Output.json()
        : Output.object({ schema: sourceAgentDecisionSchema }),
      maxOutputTokens: 12_000,
      maxRetries: 0,
      system,
      prompt
    });
    if (!result.output) throw new Error('模型没有返回源码工具决策');
    return sourceAgentDecisionSchema.parse(result.output);
  }
}

export class SourceEditingAgent {
  constructor(private readonly decisions: SourceDecisionMaker) {}

  async run(
    request: SourceTurnRequest,
    tools: SourceFileTools,
    conversation: SourceConversationTurn[] = [],
    observe?: (step: SourceAgentTraceStep) => void
  ): Promise<SourceTurnResponse> {
    const files = await tools.listFiles();
    const observations: SourceDecisionInput['observations'] = [];
    const signatures = new Set<string>();
    let toolCalls = 0;
    let modelCalls = 0;
    try {
      if (request.sourceId) {
        try {
          const selectedElement = await tools.inspectElement(request.sourceId);
          observations.push({ action: `inspect selected element: ${request.sourceId}`, result: selectedElement });
          toolCalls += 1;
        } catch (error) {
          observations.push({
            action: `inspect selected element: ${request.sourceId}`,
            result: `TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}`
          });
        }
      }
      while (true) {
        modelCalls += 1;
        const decision = await this.decisions.decide({
          request,
          files,
          conversation: conversation.slice(-8),
          observations
        });
        const signature = JSON.stringify(decision);
        if (signatures.has(signature)) {
          throw new Error(`Agent 重复执行 ${decision.action} 且没有取得进展`);
        }
        signatures.add(signature);

        if (decision.action === 'finish') {
          const validation = await tools.validate();
          const revision = await tools.commit(decision.summary);
          observe?.({ modelCall: modelCalls, action: decision.action, decision, result: validation });
          return {
            kind: 'completed',
            summary: `${decision.summary}（${validation}）`,
            revision,
            modelCalls,
            toolCalls
          };
        }
        if (decision.action === 'clarify') {
          await tools.rollback();
          observe?.({ modelCall: modelCalls, action: decision.action, decision });
          return { kind: 'clarification', question: decision.question };
        }

        toolCalls += 1;
        let result: string;
        try {
          result = decision.action === 'search'
            ? await tools.searchText(decision.query, decision.path)
            : decision.action === 'read'
              ? await tools.readFile(
                decision.path,
                decision.startLine,
                decision.endLine,
                decision.startChar,
                decision.endChar
              )
              : decision.action === 'inspect'
                ? await tools.inspectElement(decision.sourceId)
                : decision.action === 'replaceInElement'
                  ? await tools.replaceInElement(decision.sourceId, decision.search, decision.replace)
                  : decision.action === 'moveElement'
                    ? await tools.moveElement(decision.sourceId, decision.position, decision.targetSourceId)
                    : decision.action === 'cloneElement'
                      ? await tools.cloneElement(
                        decision.templateSourceId,
                        decision.position,
                        decision.targetSourceId,
                        decision.replacements
                      )
                  : await tools.replaceText(decision.path, decision.search, decision.replace);
        } catch (error) {
          result = `TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}`;
        }
        observations.push({
          action: `${decision.action}: ${decision.reason}`,
          result: result.slice(0, 16_000)
        });
        observe?.({
          modelCall: modelCalls,
          action: decision.action,
          decision,
          result: result.slice(0, 16_000)
        });
      }
    } catch (error) {
      await tools.rollback();
      return {
        kind: 'failed',
        code: 'SOURCE_AGENT_ERROR',
        message: error instanceof Error ? error.message : '源码 Agent 执行失败'
      };
    }
  }
}

export function sourceEditingAgentFromEnvironment(env: NodeJS.ProcessEnv = process.env): SourceEditingAgent {
  if (env.MODEL_MODE !== 'remote') return new SourceEditingAgent(new MockSourceDecisionMaker());
  if (!env.MODEL_BASE_URL || !env.MODEL_API_KEY || !env.MODEL_NAME) {
    throw new Error('MODEL_MODE=remote 时必须设置 MODEL_BASE_URL、MODEL_API_KEY 和 MODEL_NAME');
  }
  return new SourceEditingAgent(new RemoteSourceDecisionMaker(
    env.MODEL_BASE_URL,
    env.MODEL_API_KEY,
    env.MODEL_NAME,
    env.MODEL_PROVIDER === 'deepseek'
  ));
}
