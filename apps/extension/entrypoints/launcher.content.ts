// A lightweight entry point only. Editing/capture scripts remain loaded on demand.
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: false,
  runAt: 'document_idle',
  main(ctx) {
    if (window.top !== window || document.querySelector('[data-ui-agent-launcher]')) return;
    const host = document.createElement('div');
    host.setAttribute('data-ui-agent-launcher', 'true');
    for (const [name, value] of Object.entries({
      all: 'initial', position: 'fixed', right: '0', top: 'min(30vh, calc(100vh - 48px))',
      width: '40px', height: '40px', 'z-index': '2147483646', display: 'none',
      margin: '0', padding: '0', border: '0', 'box-sizing': 'border-box'
    })) host.style.setProperty(name, value, 'important');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { direction:ltr; }
      .launcher-open { box-sizing:border-box; position:absolute; right:0; display:flex; align-items:center;
        width:40px; height:40px; overflow:hidden;
        padding:7px; border:1px solid #eaded5; border-right:0; border-radius:20px 0 0 20px;
        background:#fff; color:#93421e; font:13px/1.4 system-ui,sans-serif;
        box-shadow:0 3px 12px #00000024; cursor:pointer; touch-action:none; user-select:none;
        transition:width 160ms ease, background-color 160ms ease; }
      :host(:hover) .launcher-open, :host(:focus-within) .launcher-open {
        width:48px; background:#ffe9dc; }
      :host([data-edge="left"]) .launcher-open { right:auto; left:0; justify-content:flex-end; border-right:1px solid #eaded5;
        border-left:0; border-radius:0 20px 20px 0; }
      :host([data-dragging]) .launcher-open { right:0; width:40px; border:1px solid #eaded5; border-radius:20px;
        cursor:grabbing; transition:none; }
      :host([data-edge="left"][data-dragging]) .launcher-open { right:auto; left:0; }
      button:focus-visible { outline:2px solid #3b82f6; outline-offset:2px; }
      button:disabled { cursor:wait; opacity:.65; }
      .launcher-close { box-sizing:border-box; position:absolute;
        top:max(-6px,calc(0px - var(--launcher-top, 0px))); width:16px; height:16px;
        padding:0; display:grid; place-items:center; border:0; border-radius:50%; background:#e8e8e8;
        color:#555; font:12px/1 system-ui,sans-serif; cursor:pointer; opacity:0; pointer-events:none;
        box-shadow:0 1px 3px #00000014; transition:opacity 120ms ease, background-color 160ms ease; }
      :host(:hover) .launcher-close, :host(:focus-within) .launcher-close {
        right:36px;
        opacity:.72; pointer-events:auto; }
      :host([data-edge="left"]) .launcher-close,
      :host([data-edge="left"]:hover) .launcher-close,
      :host([data-edge="left"]:focus-within) .launcher-close { right:auto; left:4px; }
      .launcher-close:hover, .launcher-close:focus-visible { background:#ddd; color:#333; opacity:1; }
      :host([data-dragging]) .launcher-close { visibility:hidden; }
      img { display:block; width:24px; height:24px; flex-shrink:0; pointer-events:none; }
      p { box-sizing:border-box; position:absolute; right:48px; top:0; width:min(210px,calc(100vw - 56px)); margin:0; padding:10px 12px;
        border:1px solid #e8e8e8; border-radius:10px; background:#fff; color:#343434;
        box-shadow:0 2px 10px #00000014; font:12px/1.6 system-ui,sans-serif; }
      p[hidden] { display:none; }
      :host([data-edge="left"]) p { right:auto; left:48px; }
      @media(prefers-reduced-motion:reduce) { button { transition:none; } }
      @media print { :host { display:none!important; } }
    `;
    const button = document.createElement('button');
    button.className = 'launcher-open';
    button.type = 'button';
    button.title = '点击打开UI需求助手；拖动调整位置。聚焦后可用方向键移动';
    button.setAttribute('aria-label', '打开UI需求助手');
    const icon = document.createElement('img');
    icon.src = browser.runtime.getURL('/icons/logo.svg');
    icon.alt = '';
    icon.draggable = false;
    button.append(icon);
    const error = document.createElement('p');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const positionKey = 'ui-agent:launcher-position';
    let edge: 'left' | 'right' = 'right';
    let ratio = .3;
    let interacted = false;
    let disposed = false;
    let suppressClick = false;
    let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | undefined;
    const bounds = () => ({ x: Math.max(0, document.documentElement.clientWidth - 40), y: Math.max(0, window.innerHeight - 40) });
    const place = () => {
      host.setAttribute('data-edge', edge);
      host.style.setProperty('left', edge === 'left' ? '0' : 'auto', 'important');
      host.style.setProperty('right', edge === 'right' ? '0' : 'auto', 'important');
      const top = `${Math.round(ratio * bounds().y)}px`;
      host.style.setProperty('top', top, 'important');
      host.style.setProperty('--launcher-top', top);
    };
    const save = () => {
      void browser.storage.local.set({ [positionKey]: { edge, ratio } }).catch(() => {
        // Position remains usable in this document even if persistence is unavailable.
      });
    };
    place();
    void browser.storage.local.get(positionKey).then(value => {
      if (disposed || interacted) return;
      const saved = value[positionKey];
      if (saved && typeof saved === 'object' && 'edge' in saved && 'ratio' in saved
        && (saved.edge === 'left' || saved.edge === 'right') && typeof saved.ratio === 'number' && Number.isFinite(saved.ratio)) {
        edge = saved.edge;
        ratio = Math.max(0, Math.min(1, saved.ratio));
        place();
      }
    }).catch(() => undefined);
    button.addEventListener('pointerdown', event => {
      if (!event.isTrusted || !event.isPrimary || event.button !== 0 || button.disabled) return;
      interacted = true;
      suppressClick = false;
      const rect = host.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      button.setPointerCapture(event.pointerId);
      event.stopPropagation();
    });
    button.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      suppressClick = true;
      error.hidden = true;
      event.preventDefault();
      event.stopPropagation();
      const limit = bounds();
      host.setAttribute('data-dragging', '');
      host.style.setProperty('right', 'auto', 'important');
      host.style.setProperty('left', `${Math.max(0, Math.min(limit.x, drag.left + dx))}px`, 'important');
      host.style.setProperty('top', `${Math.max(0, Math.min(limit.y, drag.top + dy))}px`, 'important');
    });
    const finishDrag = (event?: PointerEvent, commit = false) => {
      if (!drag || event && event.pointerId !== drag.id) return;
      const previous = drag;
      drag = undefined;
      if (commit && previous.moved) {
        const rect = host.getBoundingClientRect();
        const limit = bounds();
        edge = rect.left + 20 < (limit.x + 40) / 2 ? 'left' : 'right';
        ratio = limit.y ? Math.max(0, Math.min(1, rect.top / limit.y)) : 0;
        save();
      }
      host.removeAttribute('data-dragging');
      place();
      if (button.hasPointerCapture(previous.id)) button.releasePointerCapture(previous.id);
    };
    button.addEventListener('pointerup', event => finishDrag(event, true));
    button.addEventListener('pointercancel', event => finishDrag(event));
    button.addEventListener('lostpointercapture', event => finishDrag(event));
    button.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); interacted = true;
      if (event.key === 'ArrowLeft') edge = 'left';
      if (event.key === 'ArrowRight') edge = 'right';
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        ratio = Math.max(0, Math.min(1, ratio + (event.key === 'ArrowUp' ? -20 : 20) / Math.max(1, bounds().y)));
      }
      place(); save();
    });
    const resize = () => { finishDrag(); place(); };
    window.addEventListener('resize', resize);
    const closeButton = document.createElement('button');
    closeButton.className = 'launcher-close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.title = '隐藏当前页面的入口，刷新后恢复';
    closeButton.setAttribute('aria-label', '隐藏当前页面的悬浮入口，刷新后恢复');
    closeButton.addEventListener('pointerdown', event => event.stopPropagation());
    closeButton.addEventListener('click', event => {
      if (!event.isTrusted) return;
      event.preventDefault(); event.stopPropagation();
      disposed = true;
      finishDrag();
      window.removeEventListener('resize', resize);
      if (timer) clearTimeout(timer);
      browser.runtime.onMessage.removeListener(onPanelState);
      // Keep the marker so reinjection in this document does not undo dismissal.
      host.style.setProperty('display', 'none', 'important');
    });
    button.addEventListener('click', async event => {
      if (!event.isTrusted) return;
      event.stopPropagation();
      if (suppressClick && event.detail !== 0) { event.preventDefault(); return; }
      // Send directly in the click handler: no storage or tab queries before opening.
      button.disabled = true;
      error.hidden = true;
      try {
        const result = await browser.runtime.sendMessage({ type: 'ui-agent:open-side-panel' });
        if (!result?.ok) throw new Error('Side panel did not open');
      } catch {
        if (disposed) return;
        error.textContent = '暂时无法打开。请刷新页面重试，或点击浏览器工具栏中的UI需求助手图标。';
        error.hidden = false;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { error.hidden = true; }, 6000);
      } finally { button.disabled = false; }
    });
    let panelStateUpdates = 0;
    const applyPanelState = (open: boolean) => {
      if (disposed) return;
      if (open) {
        finishDrag();
        button.blur();
        closeButton.blur();
        error.hidden = true;
      }
      host.style.setProperty('display', open ? 'none' : 'block', 'important');
    };
    const onPanelState = (message: unknown, sender: Browser.runtime.MessageSender) => {
      if (sender.id !== browser.runtime.id || !message || typeof message !== 'object'
        || !('type' in message) || message.type !== 'ui-agent:side-panel-state'
        || !('open' in message) || typeof message.open !== 'boolean') return;
      panelStateUpdates++;
      applyPanelState(message.open);
    };
    browser.runtime.onMessage.addListener(onPanelState);
    shadow.append(style, button, closeButton, error);
    document.documentElement.append(host);
    // Subscribe before querying so a concurrent open/close cannot be overwritten by an older reply.
    const initialStateVersion = panelStateUpdates;
    void browser.runtime.sendMessage({ type: 'ui-agent:get-side-panel-state' }).then(state => {
      if (panelStateUpdates === initialStateVersion) applyPanelState(state?.open === true);
    }).catch(() => {
      if (panelStateUpdates === initialStateVersion) applyPanelState(false);
    });
    ctx.onInvalidated(() => {
      disposed = true;
      finishDrag();
      window.removeEventListener('resize', resize);
      browser.runtime.onMessage.removeListener(onPanelState);
      host.remove();
      if (timer) clearTimeout(timer);
    });
  }
});
