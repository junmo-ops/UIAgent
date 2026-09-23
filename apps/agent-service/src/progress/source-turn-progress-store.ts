import type { WorkspacePersistence } from '../workspace/persistence';
import type { CodingAgentEvent, CodingAgentStep } from '@ui-agent/agent-runtime';
import type { SourceTurnProgress, SourceTurnResponse } from '@ui-agent/contracts';

function phaseForAction(action: string): SourceTurnProgress['phase'] {
  if (action === 'query_workspace_structure' || action === 'query_style_symbols') return 'locating';
  if (action === 'list_files' || action === 'search_text' || action === 'search') return 'locating';
  if (
    action === 'read_file' || action === 'read_style_rule' || action === 'read_style_rules'
    || action === 'read' || action === 'inspect_element' || action === 'inspect_elements'
    || action === 'inspect'
  ) return 'reading';
  if (
    action === 'replace_text'
    || action === 'replace'
    || action === 'replace_in_element'
    || action === 'replaceInElement'
    || action === 'replace_element'
    || action === 'replaceElement'
    || action === 'remove_element'
    || action === 'removeElement'
    || action === 'set_element_text'
    || action === 'setElementText'
    || action === 'set_element_attributes'
    || action === 'setElementAttributes'
    || action === 'insert_element'
    || action === 'insertElement'
    || action === 'wrap_element'
    || action === 'wrapElement'
    || action === 'unwrap_element'
    || action === 'unwrapElement'
    || action === 'reorder_children'
    || action === 'reorderChildren'
    || action === 'apply_dom_operations'
    || action === 'applyDomOperations'
    || action === 'apply_patch'
    || action === 'move_element'
    || action === 'clone_element'
    || action === 'moveElement'
    || action === 'cloneElement'
  ) return 'editing';
  if (action === 'validate_workspace') return 'validating';
  if (action === 'validate_spatial_scope') return 'validating';
  if (action === 'finish' || action === 'clarify') return 'finishing';
  return 'analyzing';
}

function labelForAction(action: string): string {
  const labels: Record<string, string> = {
    query_workspace_structure: '定位相关页面区域',
    query_style_symbols: '查找可复用样式',
    declare_intent: '明确修改目标和范围',
    list_files: '查看源码文件',
    search_text: '搜索页面结构',
    search: '搜索页面结构',
    read_file: '读取局部源码',
    read_style_rule: '读取完整样式规则',
    read_style_rules: '批量读取样式规则',
    read: '读取局部源码',
    inspect_element: '检查选中元素',
    inspect_elements: '批量检查页面元素',
    inspect: '检查选中元素',
    replace_text: '修改页面源码',
    replace: '修改页面源码',
    replace_in_element: '修改选中元素',
    replaceInElement: '修改选中元素',
    replace_element: '替换选中元素',
    replaceElement: '替换选中元素',
    remove_element: '删除页面元素',
    removeElement: '删除页面元素',
    set_element_text: '设置元素文本',
    setElementText: '设置元素文本',
    set_element_attributes: '更新元素属性',
    setElementAttributes: '更新元素属性',
    insert_element: '插入页面元素',
    insertElement: '插入页面元素',
    wrap_element: '包裹页面元素',
    wrapElement: '包裹页面元素',
    unwrap_element: '解除元素包裹',
    unwrapElement: '解除元素包裹',
    reorder_children: '重排子元素',
    reorderChildren: '重排子元素',
    apply_dom_operations: '批量修改页面结构',
    applyDomOperations: '批量修改页面结构',
    apply_patch: '应用源码补丁',
    move_element: '移动现有元素',
    clone_element: '复用现有组件',
    moveElement: '调整元素位置',
    cloneElement: '复用现有组件',
    validate_workspace: '校验页面结构与安全',
    validate_spatial_scope: '检查新增模块的结构参照',
    finish: '检查并保存页面修改',
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
  if (Array.isArray(input.sourceIds)) return `${input.sourceIds.length} 个元素`;
  if (Array.isArray(input.classNames)) return `${input.classNames.length} 条样式规则`;
  if (typeof input.query === 'string') {
    return `“${input.query.slice(0, 40)}${input.query.length > 40 ? '…' : ''}”`;
  }
  return undefined;
}

export class SourceTurnProgressStore {
  private readonly values = new Map<string, SourceTurnProgress>();

  constructor(private readonly storage?: {
    read(workspaceId: string, turnId: string): SourceTurnProgress | undefined;
    write(value: SourceTurnProgress): void;
  }, private readonly persistence?: WorkspacePersistence) {}

  private persist(workspaceId: string, turnId: string): void {
    const value = this.values.get(this.key(workspaceId, turnId));
    if (value) this.storage?.write(value);
  }

  private record(current: SourceTurnProgress, item: NonNullable<SourceTurnProgress['timeline']>[number]) {
    const timeline = [...(current.timeline ?? [])];
    const index = timeline.findIndex(previous => previous.id === item.id);
    if (index >= 0) timeline[index] = { ...item, timestamp: timeline[index]!.timestamp };
    else timeline.push(item);
    return { timeline: timeline.slice(-500), timelineTruncated: current.timelineTruncated || timeline.length > 500 };
  }

  start(workspaceId: string, turnId: string): SourceTurnProgress {
    const timestamp = new Date().toISOString();
    const value: SourceTurnProgress = {
      workspaceId,
      turnId,
      status: 'running',
      phase: 'analyzing',
      message: '正在理解修改目标…',
      startedAt: timestamp,
      execution: 'preparing',
      saveState: 'not_started',
      modelCalls: 0,
      toolCalls: 0,
      updatedAt: timestamp,
      activities: []
    };
    this.storage?.write(value);
    const publish = () => { this.values.set(this.key(workspaceId, turnId), value); this.trim(); };
    if (this.persistence?.inTransaction) this.persistence.afterCommit(publish);
    else publish();
    return value;
  }

  get(workspaceId: string, turnId: string): SourceTurnProgress | undefined {
    const cached = this.values.get(this.key(workspaceId, turnId));
    if (cached) return cached;
    const value = this.storage?.read(workspaceId, turnId);
    if (!value) return undefined;
    // Running entries never leave the in-memory cache. A disk-only running
    // entry therefore belongs to a previous service process, not a live task.
    if (value.status === 'running' || value.status === 'cancelling') {
      const message = '服务重启或执行进程中断，本轮任务已中断。已保存的副本版本仍可继续编辑；未确认的修改请以当前页面为准。';
      Object.assign(value, { status: 'failed', execution: 'settled', phase: 'finishing',
        saveState: 'unconfirmed', message, updatedAt: new Date().toISOString(),
        result: { kind: 'failed', code: 'SOURCE_TURN_INTERRUPTED', message } });
      value.timeline = value.timeline?.map(item => item.status === 'running' ? { ...item, status: 'failed' } : item);
      this.storage?.write(value);
    }
    this.values.set(this.key(workspaceId, turnId), value);
    this.trim();
    return value;
  }

  observe(workspaceId: string, turnId: string, event: CodingAgentEvent): void {
    const current = this.get(workspaceId, turnId) ?? this.start(workspaceId, turnId);
    if (current.status !== 'running' && current.status !== 'cancelling') return;
    if (event.type === 'coding-agent.commentary') {
      if (current.status !== 'running') return;
      const text = event.text.trim().slice(0, 600);
      if (!text) return;
      this.values.set(this.key(workspaceId, turnId), { ...current,
        ...this.record(current, { id: `commentary-${event.modelCall}`, kind: 'commentary', text,
          timestamp: event.timestamp }),
        commentary: [...(current.commentary ?? []).filter(item => item.modelCall !== event.modelCall),
          { modelCall: event.modelCall, text, timestamp: event.timestamp }].slice(-8),
        updatedAt: event.timestamp });
      return;
    }
    if (event.type === 'coding-agent.persistence.updated') {
      if (this.persistence) return;
      this.values.set(this.key(workspaceId, turnId), {
        ...current, saveState: event.state, savedRevision: event.revision, updatedAt: event.timestamp
      });
      this.persist(workspaceId, turnId);
      return;
    }
    if (event.type === 'coding-agent.model.updated') {
      const previous = current.modelDetails?.find(call => call.modelCall === event.call.modelCall);
      // Raw provider reasoning belongs in diagnostics, never in progress UI payloads.
      const { reasoning: _reasoning, reasoningTruncated: _truncated, ...publicCall } = event.call;
      const call = { ...previous, ...publicCall };
      this.values.set(this.key(workspaceId, turnId), {
        ...current,
        ...(current.status === 'running' && !previous && call.status === 'running'
          ? { execution: 'model' as const, phase: 'analyzing' as const, message: '等待模型响应…' } : {}),
        ...(current.status === 'running' && current.execution === 'model' && call.status !== 'running'
          ? { execution: 'preparing' as const, message: call.status === 'failed' ? '模型请求未成功，等待任务结果…' : '模型已响应，正在处理结果…' } : {}),
        ...(current.status === 'running' && call.rateLimitWait
          ? { message: `模型服务繁忙，等待后自动重试（第 ${call.rateLimitWait.attempt}/10 次），可随时停止。` }
          : current.status === 'running' && previous?.rateLimitWait && !call.rateLimitWait
            ? { message: call.status === 'running' ? '正在重新请求模型，继续本轮修改…' : '模型请求已结束…' } : {}),
        modelCalls: Math.max(current.modelCalls, call.modelCall),
        modelDetails: [...(current.modelDetails ?? []).filter(item => item.modelCall !== call.modelCall), call]
          .sort((a, b) => a.modelCall - b.modelCall).slice(-60),
        updatedAt: event.timestamp
      });
      return;
    }
    if (event.type === 'coding-agent.tool.started') {
      if (current.status !== 'running') return;
      this.values.set(this.key(workspaceId, turnId), { ...current,
        execution: 'tool',
        ...this.record(current, { id: event.toolCallId ?? `tool-${current.toolCalls}`, kind: 'tool',
          text: labelForAction(event.action), timestamp: event.timestamp, status: 'running' }),
        ...(phaseForAction(event.action) === 'editing' && current.saveState !== 'saved'
          ? { saveState: 'editing' as const } : {}),
        ...(event.action === 'finish' ? { saveState: 'saving' as const } : {}),
        phase: phaseForAction(event.action), message: `${labelForAction(event.action)}…`,
        modelCalls: Math.max(current.modelCalls, event.modelCall), updatedAt: event.timestamp });
      return;
    }
    if (event.type === 'coding-agent.step.completed') {
      const label = labelForAction(event.step.action);
      const failed = Boolean(event.step.error);
      const blocked = event.step.outcome === 'blocked';
      const summary = inputRecord(event.step)?.summary;
      const activity: SourceTurnProgress['activities'][number] = {
        id: event.step.toolCallId ?? `${event.timestamp}-${current.toolCalls}`,
        timestamp: event.timestamp,
        action: event.step.action,
        label,
        detail: detailForStep(event.step),
        status: failed ? 'failed' : blocked ? 'blocked' : 'completed'
      };
      this.values.set(this.key(workspaceId, turnId), {
        ...current,
        execution: 'preparing',
        ...this.record(current, { id: event.step.toolCallId ?? `tool-${current.toolCalls}`, kind: 'tool',
          text: label, timestamp: event.timestamp,
          status: blocked && !failed && event.step.blockReason ? 'skipped' : activity.status,
          ...(blocked && !failed && event.step.blockReason ? { skipReason: event.step.blockReason } : {}) }),
        ...(!failed && !blocked && event.step.action === 'declare_intent' && typeof summary === 'string'
          ? { actionSummary: summary.trim().slice(0, 600) } : {}),
        ...(failed && event.step.action === 'finish' && current.saveState === 'saving' ? { saveState: 'unconfirmed' as const } : {}),
        phase: phaseForAction(event.step.action),
        message: current.status === 'cancelling' ? current.message
          : this.persistence && event.step.action === 'finish' && !failed ? '正在保存到对象存储…'
          : blocked ? `${label}被拦截，等待下一步处理…` : failed ? `${label}未成功，等待下一步处理…` : `已完成：${label}`,
        modelCalls: Math.max(current.modelCalls, event.step.modelCall),
        toolCalls: current.toolCalls + 1,
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
      this.values.set(this.key(workspaceId, turnId), {
        ...current,
        // The service still needs to attach the final result/preview URL.
        // Only complete()/fail() may publish a terminal polling status.
        execution: 'preparing',
        ...(!this.persistence && event.response.kind === 'completed' ? this.resultState(event.response) : {}),
        phase: 'finishing',
        message: current.status === 'cancelling' ? current.message : '正在整理本轮结果…',
        modelCalls: event.checkpoint.modelCalls,
        toolCalls: event.checkpoint.toolCalls,
        updatedAt: event.timestamp
      });
    }
  }

  fail(workspaceId: string, turnId: string, message: string, result?: SourceTurnResponse): void {
    const current = this.get(workspaceId, turnId) ?? this.start(workspaceId, turnId);
    this.publishTerminal({
      ...current,
      status: result?.kind === 'cancelled' ? 'cancelled' : 'failed',
      execution: 'settled',
      saveState: current.saveState === 'saved' ? 'saved' : 'unconfirmed',
      phase: 'finishing',
      message,
      result,
      updatedAt: new Date().toISOString()
    });
  }

  requestCancellation(workspaceId: string, turnId: string): SourceTurnProgress | undefined {
    const current = this.get(workspaceId, turnId);
    if (!current || current.status !== 'running') return current;
    const next = {
      ...current,
      status: 'cancelling' as const,
      phase: 'finishing' as const,
      message: '正在停止本轮修改…',
      updatedAt: new Date().toISOString()
    };
    this.values.set(this.key(workspaceId, turnId), next);
    this.persist(workspaceId, turnId);
    return next;
  }

  complete(
    workspaceId: string,
    turnId: string,
    result: SourceTurnResponse,
    modelCalls: number,
    toolCalls: number
  ): void {
    const current = this.get(workspaceId, turnId) ?? this.start(workspaceId, turnId);
    this.publishTerminal({
      ...current,
      status: result.kind === 'cancelled' ? 'cancelled' : result.kind === 'failed' ? 'failed' : 'completed',
      execution: 'settled',
      ...(result.kind === 'completed' || !['saved', 'unchanged'].includes(current.saveState ?? '')
        ? this.resultState(result) : {}),
      ...(result.kind === 'clarification' && current.saveState === 'not_started' ? { saveState: 'not_started' as const } : {}),
      phase: 'finishing',
      message: this.resultMessage(result),
      modelCalls,
      toolCalls,
      result,
      updatedAt: new Date().toISOString()
    });
  }

  private publishTerminal(value: SourceTurnProgress): void {
    this.storage?.write(value);
    const publish = () => { this.values.set(this.key(value.workspaceId, value.turnId), value); this.trim(); };
    if (this.persistence?.inTransaction) this.persistence.afterCommit(publish);
    else publish();
  }

  private key(workspaceId: string, turnId: string): string {
    return `${workspaceId}:${turnId}`;
  }

  private resultState(result: SourceTurnResponse): Partial<SourceTurnProgress> {
    if (result.kind === 'completed') return {
      saveState: result.unchanged ? 'unchanged' : 'saved', savedRevision: result.revision
    };
    // A terminal task status alone is not evidence that rollback or saving succeeded.
    return { saveState: 'unconfirmed' };
  }

  private resultMessage(result: SourceTurnResponse): string {
    if (result.kind === 'completed') return result.unchanged ? '本轮无需修改，未创建新版本' : '修改已保存';
    if (result.kind === 'clarification') return '需要你确认修改需求';
    return result.kind === 'cancelled' ? '本轮修改已停止' : '本轮修改未完成';
  }

  private trim(): void {
    for (const [key, value] of this.values) {
      if (this.values.size <= 200) break;
      if (value.status !== 'running' && value.status !== 'cancelling') this.values.delete(key);
    }
  }
}
