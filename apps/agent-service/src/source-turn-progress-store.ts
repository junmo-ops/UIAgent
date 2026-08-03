import type { CodingAgentEvent, CodingAgentStep } from '@ui-agent/agent-runtime';
import type { SourceTurnProgress } from '@ui-agent/contracts';

function phaseForAction(action: string): SourceTurnProgress['phase'] {
  if (action === 'list_files' || action === 'search_text' || action === 'search') return 'locating';
  if (action === 'read_file' || action === 'read_style_rule' || action === 'read' || action === 'inspect_element' || action === 'inspect') return 'reading';
  if (
    action === 'replace_text'
    || action === 'replace'
    || action === 'replace_in_element'
    || action === 'replaceInElement'
    || action === 'apply_patch'
    || action === 'move_element'
    || action === 'clone_element'
    || action === 'moveElement'
    || action === 'cloneElement'
  ) return 'editing';
  if (action === 'validate_workspace') return 'validating';
  if (action === 'finish' || action === 'clarify') return 'finishing';
  return 'analyzing';
}

function labelForAction(action: string): string {
  const labels: Record<string, string> = {
    list_files: '查看源码文件',
    search_text: '搜索页面结构',
    search: '搜索页面结构',
    read_file: '读取局部源码',
    read_style_rule: '读取完整样式规则',
    read: '读取局部源码',
    inspect_element: '检查选中元素',
    inspect: '检查选中元素',
    replace_text: '修改页面源码',
    replace: '修改页面源码',
    replace_in_element: '修改选中元素',
    replaceInElement: '修改选中元素',
    apply_patch: '应用源码补丁',
    move_element: '移动现有元素',
    clone_element: '复用现有组件',
    moveElement: '调整元素位置',
    cloneElement: '复用现有组件',
    validate_workspace: '校验页面结构与安全',
    finish: '提交页面修改',
    clarify: '整理待确认问题'
  };
  return labels[action] ?? '处理页面修改';
}

function inputRecord(step: CodingAgentStep): Record<string, unknown> | undefined {
  if (!step.input || typeof step.input !== 'object' || Array.isArray(step.input)) return undefined;
  return step.input as Record<string, unknown>;
}

function detailForStep(step: CodingAgentStep): string | undefined {
  const input = inputRecord(step);
  if (!input) return undefined;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.className === 'string') return `.${input.className.replace(/^\./, '')}`;
  if (typeof input.sourceId === 'string') return `元素 ${input.sourceId}`;
  if (typeof input.query === 'string') {
    return `“${input.query.slice(0, 40)}${input.query.length > 40 ? '…' : ''}”`;
  }
  return undefined;
}

export class SourceTurnProgressStore {
  private readonly values = new Map<string, SourceTurnProgress>();

  start(workspaceId: string, turnId: string): SourceTurnProgress {
    const timestamp = new Date().toISOString();
    const value: SourceTurnProgress = {
      workspaceId,
      turnId,
      status: 'running',
      phase: 'analyzing',
      message: '正在理解修改目标…',
      modelCalls: 0,
      toolCalls: 0,
      updatedAt: timestamp,
      activities: []
    };
    this.values.set(this.key(workspaceId, turnId), value);
    this.trim();
    return value;
  }

  get(workspaceId: string, turnId: string): SourceTurnProgress | undefined {
    return this.values.get(this.key(workspaceId, turnId));
  }

  observe(workspaceId: string, turnId: string, event: CodingAgentEvent): void {
    const current = this.get(workspaceId, turnId) ?? this.start(workspaceId, turnId);
    if (event.type === 'coding-agent.step.completed') {
      const label = labelForAction(event.step.action);
      const failed = Boolean(event.step.error);
      const activity: SourceTurnProgress['activities'][number] = {
        id: `${event.timestamp}-${current.activities.length}`,
        timestamp: event.timestamp,
        action: event.step.action,
        label,
        detail: detailForStep(event.step),
        status: failed ? 'failed' : 'completed'
      };
      this.values.set(this.key(workspaceId, turnId), {
        ...current,
        phase: phaseForAction(event.step.action),
        message: failed ? `${label}遇到问题，正在调整策略…` : `${label}…`,
        modelCalls: Math.max(current.modelCalls, event.step.modelCall),
        toolCalls: current.toolCalls + (
          event.step.action === 'finish' || event.step.action === 'clarify' ? 0 : 1
        ),
        updatedAt: event.timestamp,
        activities: [...current.activities, activity].slice(-12)
      });
      return;
    }
    if (event.type === 'coding-agent.checkpoint.updated') {
      this.values.set(this.key(workspaceId, turnId), {
        ...current,
        modelCalls: event.checkpoint.modelCalls,
        toolCalls: event.checkpoint.toolCalls,
        updatedAt: event.timestamp
      });
      return;
    }
    if (event.type === 'coding-agent.turn.completed') {
      const failed = event.response.kind === 'failed';
      this.values.set(this.key(workspaceId, turnId), {
        ...current,
        status: failed ? 'failed' : 'completed',
        phase: 'finishing',
        message: failed ? '本轮修改未完成' : '本轮处理完成',
        modelCalls: event.checkpoint.modelCalls,
        toolCalls: event.checkpoint.toolCalls,
        updatedAt: event.timestamp
      });
    }
  }

  fail(workspaceId: string, turnId: string, message: string): void {
    const current = this.get(workspaceId, turnId) ?? this.start(workspaceId, turnId);
    this.values.set(this.key(workspaceId, turnId), {
      ...current,
      status: 'failed',
      phase: 'finishing',
      message,
      updatedAt: new Date().toISOString()
    });
  }

  complete(
    workspaceId: string,
    turnId: string,
    failed: boolean,
    modelCalls: number,
    toolCalls: number
  ): void {
    const current = this.get(workspaceId, turnId) ?? this.start(workspaceId, turnId);
    this.values.set(this.key(workspaceId, turnId), {
      ...current,
      status: failed ? 'failed' : 'completed',
      phase: 'finishing',
      message: failed ? '本轮修改未完成' : '本轮处理完成',
      modelCalls,
      toolCalls,
      updatedAt: new Date().toISOString()
    });
  }

  private key(workspaceId: string, turnId: string): string {
    return `${workspaceId}:${turnId}`;
  }

  private trim(): void {
    if (this.values.size <= 200) return;
    const oldest = this.values.keys().next().value as string | undefined;
    if (oldest) this.values.delete(oldest);
  }
}
