import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROTOCOL_VERSION,
  agentTurnResponseSchema,
  executionSubmissionSchema,
  startTurnRequestSchema,
  type ChangePlan,
  type ContentCommand,
  type ContentCommandResult,
  type SelectedContext
} from '@ui-agent/contracts';
import type {
  ChallengeDriver,
  ChallengeScenario,
  ChallengeTurnResult
} from '@ui-agent/ui-change-eval';
import {
  chromium,
  type BrowserContext,
  type Page
} from 'playwright';

type SuccessfulCommand = Extract<ContentCommandResult, { ok: true }>;

export interface ChromeChallengeDriverOptions {
  extensionPath: string;
  pageUrl: string;
  serviceUrl: string;
  keepBrowser?: boolean;
}

export class ChromeChallengeDriver implements ChallengeDriver {
  private context?: BrowserContext;
  private demoPage?: Page;
  private bridgePage?: Page;
  private profileDirectory?: string;
  private editSessionId = '';

  constructor(private readonly options: ChromeChallengeDriverOptions) {}

  async open(): Promise<void> {
    this.profileDirectory = await mkdtemp(join(tmpdir(), 'ui-agent-challenge-'));
    this.context = await chromium.launchPersistentContext(this.profileDirectory, {
      channel: 'chromium',
      headless: false,
      viewport: { width: 1440, height: 960 },
      args: [
        `--disable-extensions-except=${this.options.extensionPath}`,
        `--load-extension=${this.options.extensionPath}`
      ]
    });
    let worker = this.context.serviceWorkers()[0];
    worker ??= await this.context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    this.demoPage = this.context.pages()[0] ?? await this.context.newPage();
    await this.demoPage.goto(this.options.pageUrl);
    this.bridgePage = await this.context.newPage();
    await this.bridgePage.goto(`chrome-extension://${extensionId}/evaluation.html`);
    await this.bridgePage.waitForFunction(() =>
      document.documentElement.getAttribute('data-ui-agent-evaluation-ready') === 'true'
    );
  }

  async close(): Promise<void> {
    if (this.options.keepBrowser) return;
    await this.context?.close();
    if (this.profileDirectory) await rm(this.profileDirectory, { recursive: true, force: true });
  }

  async startScenario(scenario: ChallengeScenario): Promise<void> {
    this.assertOpen();
    this.editSessionId = crypto.randomUUID();
    const url = scenario.page === 'orders'
      ? this.options.pageUrl
      : `${this.options.pageUrl}/?page=${scenario.page}`;
    await this.demoPage!.goto(url);
    await this.demoPage!.waitForSelector(`[data-testid="${scenario.selectionTestId}"]`);
    const selected = await this.command({ type: 'selectFixture', testId: scenario.selectionTestId });
    if (!selected.context) throw new Error(`场景 ${scenario.id} 没有获得选区上下文`);
  }

  async finishScenario(): Promise<void> {
    await this.command({ type: 'reset' }).catch(() => undefined);
  }

  async runTurn(
    scenario: ChallengeScenario,
    _turnIndex: number,
    instruction: string
  ): Promise<ChallengeTurnResult> {
    const beforeResult = await this.command({ type: 'getContext' });
    if (!beforeResult.context) return { kind: 'failed' };
    const beforeContext = beforeResult.context;
    const turn = { turnId: crypto.randomUUID(), traceId: crypto.randomUUID() };
    const request = startTurnRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      editSessionId: this.editSessionId,
      ...turn,
      instruction,
      context: beforeContext
    });
    const response = await this.post('/v1/turns', request);
    const result = agentTurnResponseSchema.parse(response);
    if (result.kind === 'clarification') {
      return {
        kind: 'clarification', beforeContext,
        clarification: {
          reason: result.clarification.reason,
          question: result.clarification.question
        }
      };
    }
    if (result.kind !== 'execution') return { kind: 'failed', beforeContext };
    return this.executePlan(scenario, beforeContext, turn, result.plan, 0);
  }

  private async executePlan(
    scenario: ChallengeScenario,
    beforeContext: SelectedContext,
    turn: { turnId: string; traceId: string },
    plan: ChangePlan,
    repairCount: number
  ): Promise<ChallengeTurnResult> {
    if (plan.requiresConfirmation && scenario.requiresConfirmation !== true) {
      return { kind: 'failed', beforeContext, plan, repairCount };
    }
    const execution = await this.command({
      type: 'applyPlan',
      plan,
      confirmedExistingRemoval: scenario.requiresConfirmation === true
    });
    if (!execution.receipt) return { kind: 'failed', beforeContext, plan, repairCount };
    const contextResult = await this.command({ type: 'getContext' });
    if (!contextResult.context) {
      return { kind: 'failed', beforeContext, plan, receipt: execution.receipt, repairCount };
    }
    const observation = contextResult.context;
    const submission = executionSubmissionSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      editSessionId: this.editSessionId,
      ...turn,
      planId: plan.planId,
      beforePageRevision: plan.pageRevision,
      receipt: execution.receipt,
      observation
    });
    const response = await this.post(`/v1/turns/${turn.turnId}/execution`, submission);
    const outcome = agentTurnResponseSchema.parse(response);
    if (outcome.kind === 'completed') {
      return {
        kind: 'execution', beforeContext, plan,
        receipt: execution.receipt, observation,
        verification: outcome.verification, repairCount
      };
    }
    if (outcome.kind === 'execution' && repairCount < 1) {
      return this.executePlan(scenario, beforeContext, turn, outcome.plan, repairCount + 1);
    }
    if (outcome.kind === 'clarification') {
      return {
        kind: 'clarification', beforeContext, plan,
        receipt: execution.receipt, observation, repairCount,
        clarification: {
          reason: outcome.clarification.reason,
          question: outcome.clarification.question
        }
      };
    }
    return {
      kind: 'failed', beforeContext, plan,
      receipt: execution.receipt, observation,
      verification: outcome.kind === 'failed' ? outcome.verification : undefined,
      repairCount
    };
  }

  private async command(value: ContentCommand): Promise<SuccessfulCommand> {
    this.assertOpen();
    const result = await this.bridgePage!.evaluate(async command => {
      const evaluationWindow = window as unknown as {
        uiAgentEvaluation: { command(value: ContentCommand): Promise<ContentCommandResult> }
      };
      return evaluationWindow.uiAgentEvaluation.command(command);
    }, value);
    if (!result.ok) throw new Error(`[${result.code}] ${result.error}`);
    return result;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.options.serviceUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Agent Service ${path} 返回 ${response.status}: ${await response.text()}`);
    return response.json();
  }

  private assertOpen(): void {
    if (!this.context || !this.demoPage || !this.bridgePage) {
      throw new Error('Chrome Challenge Driver 尚未启动');
    }
  }
}
