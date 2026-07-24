import { changePlanSchema, type ContentCommandResult } from '@ui-agent/contracts';
import { DomEngine } from '../src/content/dom-engine';
import { selectionTarget } from '../src/content/selection-target';
import { onMessage, sendMessage } from '../src/messaging';

export default defineContentScript({
  matches: ['http://127.0.0.1/*', 'http://localhost/*'],
  main() {
    const engine = new DomEngine();
    let selecting = false;
    let editorLeaseTimer: ReturnType<typeof setTimeout> | undefined;

    const deactivateEditor = () => {
      selecting = false;
      engine.disableOverlay();
      if (editorLeaseTimer) clearTimeout(editorLeaseTimer);
      editorLeaseTimer = undefined;
    };
    const refreshEditorLease = () => {
      if (editorLeaseTimer) clearTimeout(editorLeaseTimer);
      editorLeaseTimer = setTimeout(deactivateEditor, 7000);
    };

    const hover = (event: MouseEvent) => {
      if (!selecting) return;
      const target = selectionTarget(event.target);
      if (!target || target.hasAttribute('data-ui-agent-overlay')) return;
      engine.preview(target);
    };
    const choose = (event: MouseEvent) => {
      if (!selecting) return;
      const target = selectionTarget(event.target);
      if (!target || target.hasAttribute('data-ui-agent-overlay')) return;
      event.preventDefault(); event.stopImmediatePropagation(); selecting = false;
      const context = engine.select(target);
      sendMessage('selectionChanged', context).catch(() => undefined);
    };
    document.addEventListener('mousemove', hover, true);
    document.addEventListener('click', choose, true);
    addEventListener('scroll', () => engine.refreshOverlay(), true);
    addEventListener('resize', () => engine.refreshOverlay());

    onMessage('contentCommand', async message => {
      try {
        const command = message.data;
        if (command.type === 'editorHeartbeat') { refreshEditorLease(); return { ok: true } satisfies ContentCommandResult; }
        if (command.type === 'deactivateEditor') { deactivateEditor(); return { ok: true } satisfies ContentCommandResult; }
        if (command.type === 'startSelection') {
          refreshEditorLease();
          engine.enableOverlay();
          selecting = true;
          return { ok: true } satisfies ContentCommandResult;
        }
        if (command.type === 'selectFixture') {
          const evaluationPage = ['127.0.0.1', 'localhost'].includes(location.hostname) && location.port === '5173';
          if (!evaluationPage) throw new Error('自动化选区仅允许固定本地测试页');
          const target = [...document.querySelectorAll<HTMLElement>('[data-testid]')]
            .find(element => element.getAttribute('data-testid') === command.testId);
          if (!target) throw new Error(`测试页不存在选区 ${command.testId}`);
          return { ok: true, context: engine.select(target), ...engine.historyState() } satisfies ContentCommandResult;
        }
        if (command.type === 'getContext') return {
          ok: true,
          context: engine.context(command.scopes, command.targetNodeIds),
          ...engine.historyState()
        } satisfies ContentCommandResult;
        if (command.type === 'applyPlan') {
          const plan = changePlanSchema.parse(command.plan);
          return { ok: true, receipt: engine.applyPlan(plan, command.confirmedExistingRemoval), ...engine.historyState() } satisfies ContentCommandResult;
        }
        if (command.type === 'undo') return { ok: true, canUndo: (engine.undo(), engine.historyState().canUndo), canRedo: engine.historyState().canRedo } satisfies ContentCommandResult;
        if (command.type === 'redo') return { ok: true, canUndo: (engine.redo(), engine.historyState().canUndo), canRedo: engine.historyState().canRedo } satisfies ContentCommandResult;
        if (command.type === 'reset') { engine.reset(); return { ok: true, ...engine.historyState() } satisfies ContentCommandResult; }
        if (command.type === 'prepareScreenshot') { engine.hideOverlay(); return { ok: true } satisfies ContentCommandResult; }
        if (command.type === 'finishScreenshot') { engine.refreshOverlay(); return { ok: true } satisfies ContentCommandResult; }
        return { ok: false, code: 'PAGE_OPERATION_FAILED', error: '该命令只能由 Background 执行' } satisfies ContentCommandResult;
      } catch (error) {
        const knownCode = error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'PAGE_OPERATION_FAILED';
        const code = knownCode === 'POLICY_ERROR' ? 'POLICY_ERROR'
          : /页面或选区已变化/.test(error instanceof Error ? error.message : '') ? 'STALE_CONTEXT'
            : 'PAGE_OPERATION_FAILED';
        return { ok: false, code, error: error instanceof Error ? error.message : '页面操作失败' } satisfies ContentCommandResult;
      }
    });
  }
});
