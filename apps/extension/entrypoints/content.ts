import type { ContentCommandResult, DocumentRef } from '@ui-agent/contracts';
import { selectionTarget } from '../src/content/selection-target';
import { captureStaticSnapshot } from '../src/content/snapshot-capture';
import { ControlledInteractionRuntime } from '../src/content/controlled-interactions';
import { SelectionOverlay } from '../src/content/selection-overlay';
import { onMessage, sendMessage } from '../src/messaging';

function serializeLiveRect(rect: DOMRect) {
  return {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left
  };
}

function nextFrame(): Promise<void> {
  // Background tabs can suspend requestAnimationFrame. The timer keeps this
  // bounded; a later stability check still decides whether evidence is usable.
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 120);
    requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  });
}

function previewState() {
  return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, scroll: { x: scrollX, y: scrollY } };
}

function assertDocumentRef(documentRef: DocumentRef) {
  const marker = document.querySelector('meta[name="ui-agent-document-ref"]');
  if (!marker
    || marker.getAttribute('data-workspace-id') !== documentRef.workspaceId
    || marker.getAttribute('data-candidate-id') !== documentRef.candidateId
    || marker.getAttribute('data-candidate-version') !== String(documentRef.candidateVersion)
    || marker.getAttribute('data-content-hash') !== documentRef.contentHash
    || marker.getAttribute('data-render-mode') !== documentRef.renderMode) throw new Error('候选预览身份与渲染任务不一致');
}

async function waitForRenderReadiness(sourceIds: string[]) {
  const timeout = <T,>(promise: Promise<T>, fallback: T) => Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), 1_500))
  ]);
  let fonts: 'ready' | 'timeout' | 'unsupported' = 'unsupported';
  if (document.fonts) {
    fonts = await timeout(document.fonts.ready.then(() => 'ready' as const, () => 'timeout' as const), 'timeout');
  }
  // A page can contain unrelated lazy-loaded or already-broken images. Their
  // state must not decide whether a local edit is renderable.  Measure images
  // owned by the requested verification targets instead; CSS backgrounds and
  // other non-image-element resources are represented by layout stability.
  const requested = new Set(sourceIds.slice(0, 100));
  const images = Array.from(document.querySelectorAll<HTMLElement>('[data-ui-source-id]'))
    .filter(element => requested.has(element.getAttribute('data-ui-source-id') ?? ''))
    .flatMap(element => Array.from(element.querySelectorAll('img')));
  await timeout(Promise.all(images.map(image => {
    if (image.complete) return Promise.resolve();
    return image.decode().catch(() => undefined);
  })), undefined);
  const imageState = {
    total: images.length,
    ready: images.filter(image => image.complete && image.naturalWidth > 0).length,
    failed: images.filter(image => image.complete && image.naturalWidth === 0).length
  };
  let prior = '';
  let consecutive = 0;
  const deadline = performance.now() + 1_000;
  while (consecutive < 3 && performance.now() < deadline) {
    await nextFrame();
    const signature = Array.from(document.querySelectorAll<HTMLElement>('[data-ui-source-id]'))
      .filter(element => requested.has(element.getAttribute('data-ui-source-id') ?? ''))
      .map(element => {
        const rect = element.getBoundingClientRect();
        return `${element.getAttribute('data-ui-source-id')}:${rect.x},${rect.y},${rect.width},${rect.height}`;
      }).join('|');
    consecutive = signature === prior ? consecutive + 1 : 0;
    prior = signature;
  }
  return { fonts, images: imageState, layoutStable: consecutive >= 3 };
}

async function observeWorkspacePreview(sourceIds: string[], documentRef: DocumentRef, sampleId: string) {
  assertDocumentRef(documentRef);
  const readiness = await waitForRenderReadiness(sourceIds);
  const requested = new Set(sourceIds.slice(0, 100));
  const elements = new Map<string, HTMLElement>();
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-ui-source-id]'))) {
    const sourceId = element.getAttribute('data-ui-source-id');
    if (sourceId && requested.has(sourceId)) elements.set(sourceId, element);
  }
  const nodes = [...elements.entries()].map(([sourceId, element]) => {
    const style = getComputedStyle(element);
    const clippingAncestors: Array<{
      sourceId?: string; tag: string; overflowX: string; overflowY: string;
      rect: ReturnType<typeof serializeLiveRect>;
    }> = [];
    let parent = element.parentElement;
    while (parent && clippingAncestors.length < 32) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.overflowX !== 'visible' || parentStyle.overflowY !== 'visible') {
        clippingAncestors.push({
          ...(parent.getAttribute('data-ui-source-id') ? { sourceId: parent.getAttribute('data-ui-source-id')! } : {}),
          tag: parent.tagName.toLowerCase(),
          overflowX: parentStyle.overflowX,
          overflowY: parentStyle.overflowY,
          rect: serializeLiveRect(parent.getBoundingClientRect())
        });
      }
      parent = parent.parentElement;
    }
    return {
      sourceId,
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2_000),
      ...(element.parentElement?.getAttribute('data-ui-source-id')
        ? { parentSourceId: element.parentElement.getAttribute('data-ui-source-id')! }
        : {}),
      rect: serializeLiveRect(element.getBoundingClientRect()),
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      styles: {
        display: style.display,
        position: style.position,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        visibility: style.visibility,
        opacity: style.opacity,
        flexDirection: style.flexDirection,
        gap: style.gap,
        gridTemplateColumns: style.gridTemplateColumns,
        gridTemplateRows: style.gridTemplateRows,
        font: style.font,
        lineHeight: style.lineHeight
      },
      clippingAncestors
    };
  });
  return {
    sampleId,
    sampledAt: new Date().toISOString(),
    ...previewState(),
    nodes,
    missingSourceIds: [...requested].filter(sourceId => !elements.has(sourceId)),
    readiness
  };
}

const localContentMatches = ['http://127.0.0.1/*', 'http://localhost/*'];
declare const __UI_AGENT_SERVICE_ORIGIN__: string;
const configuredServiceOrigin = __UI_AGENT_SERVICE_ORIGIN__;
// Chrome content-script match patterns cannot contain ports. Runtime preview URL
// validation still compares the full origin, including the configured port.
const configuredServiceMatch = (() => {
  const url = new URL(configuredServiceOrigin);
  return `${url.protocol}//${url.hostname}/*`;
})();

export default defineContentScript({
  // The preview is served by Agent Service itself. Keep the local matches for
  // development, and add only the configured service origin for cloud previews
  // instead of injecting this script into arbitrary websites.
  matches: [...new Set([...localContentMatches, configuredServiceMatch])],
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
          return { ok: true, snapshot: captureStaticSnapshot(document.body, command.includeFrozenStyles === true) } satisfies ContentCommandResult;
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
          return { ok: true, snapshot: captureStaticSnapshot(document.body, command.includeFrozenStyles === true) } satisfies ContentCommandResult;
        }
        if (command.type === 'prepareScreenshot') { selection.hide(); return { ok: true } satisfies ContentCommandResult; }
        if (command.type === 'finishScreenshot') { selection.refresh(); return { ok: true } satisfies ContentCommandResult; }
        if (command.type === 'observeWorkspacePreview') {
          if (!document.body.hasAttribute('data-ui-agent-static-snapshot')) {
            return { ok: false, code: 'INVALID_PAGE_URL', error: '实时观察只允许在 Agent Service 提供的静态副本中执行' } satisfies ContentCommandResult;
          }
          return { ok: true, observation: await observeWorkspacePreview(command.sourceIds, command.document, command.sampleId) } satisfies ContentCommandResult;
        }
        if (command.type === 'readWorkspacePreviewState') {
          if (!document.body.hasAttribute('data-ui-agent-static-snapshot')) {
            return { ok: false, code: 'INVALID_PAGE_URL', error: '页面状态只能从 Agent Service 提供的静态副本读取' } satisfies ContentCommandResult;
          }
          assertDocumentRef(command.document);
          return { ok: true, renderState: previewState() } satisfies ContentCommandResult;
        }
        return { ok: false, code: 'PAGE_OPERATION_FAILED', error: '该命令只能由 Background 执行' } satisfies ContentCommandResult;
      } catch (error) {
        return { ok: false, code: 'PAGE_OPERATION_FAILED', error: error instanceof Error ? error.message : '页面操作失败' } satisfies ContentCommandResult;
      }
    });
  }
});
