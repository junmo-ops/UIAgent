import type { ContentCommandResult } from '@ui-agent/contracts';
import { selectionTarget } from '../src/content/selection-target';
import { captureStaticSnapshot } from '../src/content/snapshot-capture';
import { ControlledInteractionRuntime } from '../src/content/controlled-interactions';
import { SelectionOverlay } from '../src/content/selection-overlay';
import { onMessage, sendMessage } from '../src/messaging';

export default defineContentScript({
  matches: ['http://127.0.0.1/*', 'http://localhost/*'],
  main() {
    const selection = new SelectionOverlay();
    const interactions = document.body.hasAttribute('data-ui-agent-static-snapshot')
      ? new ControlledInteractionRuntime(document)
      : undefined;
    interactions?.mount();
    let selecting = false;
    let editorLeaseTimer: ReturnType<typeof setTimeout> | undefined;

    const deactivateEditor = () => {
      selecting = false;
      selection.disable();
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
      selection.preview(target);
    };
    const choose = (event: MouseEvent) => {
      if (!selecting) return;
      const target = selectionTarget(event.target);
      if (!target || target.hasAttribute('data-ui-agent-overlay')) return;
      event.preventDefault(); event.stopImmediatePropagation(); selecting = false;
      sendMessage('selectionChanged', selection.select(target)).catch(() => undefined);
    };
    document.addEventListener('mousemove', hover, true);
    document.addEventListener('click', choose, true);
    addEventListener('scroll', () => selection.refresh(), true);
    addEventListener('resize', () => selection.refresh());

    onMessage('contentCommand', async message => {
      try {
        const command = message.data;
        if (command.type === 'editorHeartbeat') { refreshEditorLease(); return { ok: true } satisfies ContentCommandResult; }
        if (command.type === 'deactivateEditor') { deactivateEditor(); return { ok: true } satisfies ContentCommandResult; }
        if (command.type === 'startSelection') {
          refreshEditorLease();
          selection.enable();
          selecting = true;
          return { ok: true } satisfies ContentCommandResult;
        }
        if (command.type === 'capturePageSnapshot') {
          return { ok: true, snapshot: captureStaticSnapshot(document.body) } satisfies ContentCommandResult;
        }
        if (command.type === 'capturePageSnapshotAfterViewportReflow') {
          // Side Panel removal changes CSS media queries and layout. Capture only
          // after the browser has observed a stable viewport for several frames.
          let stableFrames = 0;
          let previousWidth = innerWidth;
          const deadline = performance.now() + 1_000;
          while (stableFrames < 3 && performance.now() < deadline) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            if (innerWidth === previousWidth) stableFrames += 1;
            else {
              previousWidth = innerWidth;
              stableFrames = 0;
            }
          }
          return { ok: true, snapshot: captureStaticSnapshot(document.body) } satisfies ContentCommandResult;
        }
        if (command.type === 'prepareScreenshot') { selection.hide(); return { ok: true } satisfies ContentCommandResult; }
        if (command.type === 'finishScreenshot') { selection.refresh(); return { ok: true } satisfies ContentCommandResult; }
        return { ok: false, code: 'PAGE_OPERATION_FAILED', error: '该命令只能由 Background 执行' } satisfies ContentCommandResult;
      } catch (error) {
        return { ok: false, code: 'PAGE_OPERATION_FAILED', error: error instanceof Error ? error.message : '页面操作失败' } satisfies ContentCommandResult;
      }
    });
  }
});
