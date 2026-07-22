import { changePlanSchema, type ContentCommandResult } from '@ui-agent/contracts';
import { DomEngine } from '../src/content/dom-engine';
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
      if (!selecting || !(event.target instanceof HTMLElement) || event.target.hasAttribute('data-ui-agent-overlay')) return;
      engine.preview(event.target);
    };
    const choose = (event: MouseEvent) => {
      if (!selecting || !(event.target instanceof HTMLElement) || event.target.hasAttribute('data-ui-agent-overlay')) return;
      event.preventDefault(); event.stopImmediatePropagation(); selecting = false;
      const context = engine.select(event.target);
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
        if (command.type === 'getContext') return { ok: true, context: engine.context(), ...engine.historyState() } satisfies ContentCommandResult;
        if (command.type === 'applyPlan') {
          const plan = changePlanSchema.parse(command.plan);
          return { ok: true, receipt: engine.applyPlan(plan, command.confirmedExistingRemoval), ...engine.historyState() } satisfies ContentCommandResult;
        }
        if (command.type === 'undo') return { ok: true, canUndo: (engine.undo(), engine.historyState().canUndo), canRedo: engine.historyState().canRedo } satisfies ContentCommandResult;
        if (command.type === 'redo') return { ok: true, canUndo: (engine.redo(), engine.historyState().canUndo), canRedo: engine.historyState().canRedo } satisfies ContentCommandResult;
        if (command.type === 'reset') { engine.reset(); return { ok: true, ...engine.historyState() } satisfies ContentCommandResult; }
        if (command.type === 'prepareScreenshot') { engine.hideOverlay(); return { ok: true } satisfies ContentCommandResult; }
        if (command.type === 'finishScreenshot') { engine.refreshOverlay(); return { ok: true } satisfies ContentCommandResult; }
        return { ok: false, error: '该命令只能由 Background 执行' } satisfies ContentCommandResult;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '页面操作失败' } satisfies ContentCommandResult;
      }
    });
  }
});
