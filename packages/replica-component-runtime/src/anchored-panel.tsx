import React from 'react';
import { createPortal } from 'react-dom';
import { ConfigProvider } from 'antd';

export interface AnchoredPanelProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  children: React.ReactNode;
  width?: number;
  placement?: 'bottom' | 'top';
  align?: 'start' | 'end';
  gap?: number;
  viewportPadding?: number;
  label?: string;
}

type Bounds = { left: number; top: number; width: number; maxHeight: number };

/** An anchored surface; content and trigger state remain owned by the module. */
export function AnchoredPanel({ anchorRef, open, onClose, children, width = 360,
  placement = 'bottom', align = 'start', gap = 6, viewportPadding = 8, label }: AnchoredPanelProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  // Ant Design portals must stay inside this top-layer element. Keep them
  // outside the scrolling surface so its overflow does not clip child menus.
  const getPopupContainer = React.useCallback(() => panelRef.current!, []);
  const [bounds, setBounds] = React.useState<Bounds>();
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useLayoutEffect(() => {
    if (!open) { setBounds(undefined); return; }
    const anchor = anchorRef.current;
    if (!anchor) return;
    // The browser top layer avoids transformed/clipped page ancestors and
    // arbitrary stacking contexts. Chrome 120 is the runtime's build target.
    const panel = panelRef.current;
    panel?.showPopover();
    const measure = () => {
      if (!anchor.isConnected) { closeRef.current(); return; }
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewLeft = viewport?.offsetLeft ?? 0;
      const viewTop = viewport?.offsetTop ?? 0;
      const viewWidth = viewport?.width ?? window.innerWidth;
      const viewHeight = viewport?.height ?? window.innerHeight;
      const padding = Math.max(0, Math.min(viewportPadding, viewWidth / 2, viewHeight / 2));
      const minX = viewLeft + padding, maxX = viewLeft + viewWidth - padding;
      const minY = viewTop + padding, maxY = viewTop + viewHeight - padding;
      const actualWidth = Math.max(0, Math.min(Number.isFinite(width) ? width : 360, maxX - minX));
      const offset = Math.max(0, gap);
      const below = Math.max(0, maxY - Math.max(minY, rect.bottom + offset));
      const above = Math.max(0, Math.min(maxY, rect.top - offset) - minY);
      const preferredRoom = placement === 'bottom' ? below : above;
      const otherRoom = placement === 'bottom' ? above : below;
      // Measure the complete surface, including headings, controls and padding.
      // A flexible result region may shrink; compare its current rendered size.
      const surface = surfaceRef.current;
      const panelStyle = surface ? getComputedStyle(surface) : undefined;
      const desiredHeight = surface ? surface.scrollHeight + parseFloat(panelStyle!.borderTopWidth)
        + parseFloat(panelStyle!.borderBottomWidth) : Number.POSITIVE_INFINITY;
      const side = desiredHeight > preferredRoom && otherRoom > preferredRoom
        ? placement === 'bottom' ? 'top' : 'bottom' : placement;
      const maxHeight = side === 'bottom' ? below : above;
      const actualHeight = Math.min(desiredHeight, maxHeight);
      const left = Math.max(minX, Math.min(align === 'end' ? rect.right - actualWidth : rect.left, maxX - actualWidth));
      const top = Math.max(minY, Math.min(side === 'bottom' ? rect.bottom + offset : rect.top - offset - actualHeight,
        maxY - actualHeight));
      const next = { left, top, width: actualWidth, maxHeight };
      setBounds(previous => previous && Object.keys(next).every(key =>
        Math.abs(previous[key as keyof Bounds] - next[key as keyof Bounds]) < 0.5) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    if (panelRef.current) observer.observe(panelRef.current);
    if (surfaceRef.current) observer.observe(surfaceRef.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      if (panel?.isConnected && panel.matches(':popover-open')) panel.hidePopover();
    };
  }, [open, anchorRef, width, placement, align, gap, viewportPadding]);

  React.useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) closeRef.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current();
      anchorRef.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open, anchorRef]);

  if (!open) return null;
  return createPortal(<div ref={panelRef} popover="manual" role="dialog" aria-label={label} style={{
    position: 'fixed', left: bounds?.left ?? 0, top: bounds?.top ?? 0,
    width: bounds?.width ?? width,
    visibility: bounds ? 'visible' : 'hidden', boxSizing: 'border-box',
    margin: 0, right: 'auto', bottom: 'auto',
    padding: 0, border: 0, background: 'transparent', overflow: 'visible', zIndex: 10000
  }}><ConfigProvider getPopupContainer={getPopupContainer}>
    <div ref={surfaceRef} style={{
    display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto',
    maxHeight: bounds?.maxHeight ?? 0, boxSizing: 'border-box',
    padding: 12, border: '1px solid #e5e7eb', borderRadius: 8,
    background: '#fff', color: '#1f2937', boxShadow: '0 8px 24px rgba(0,0,0,.14)', zIndex: 10000
  }}>{children}</div></ConfigProvider></div>, document.body);
}
