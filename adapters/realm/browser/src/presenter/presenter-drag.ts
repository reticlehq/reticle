import {
  HUD_DRAG_IGNORE_SEL,
  HUD_DRAG_THRESHOLD_PX,
  MIN_ATTR,
  CHAT_ATTR,
  SETTINGS_ATTR,
} from './presenter-config.js';
import { scheduleSyncDockLayout } from './presenter-dock-layout.js';
import {
  applyHudPosition,
  clampHudPosition,
  hudLayoutBox,
  relayoutHudPosition,
} from './presenter-hud-position.js';
export {
  applyHudPosition,
  isHudDragged,
  readHudPosition,
  relayoutHudPosition,
  clampHudPosition,
  hudLayoutBox,
  resetHudDockPosition,
} from './presenter-hud-position.js';

interface HudDragCallbacks {
  onDragMove?: () => void;
  /** Fires when a drag gesture ends; `moved` is true when the panel actually changed position. */
  onDragEnd?: (moved: boolean) => void;
}

const DRAG_HANDLE_DRAGGING_CLASS = 'reticle-drag-handle--dragging';

/**
 * Keep a dragged HUD inside the viewport when the window or panel size changes
 * (minimise ↔ expand, tally appearing, viewport resize).
 */
export function installHudPositionGuards(hud: HTMLElement, overlay: HTMLElement): () => void {
  const scheduleRelayout = (): void => {
    scheduleSyncDockLayout(hud, overlay);
  };

  // One signal for all three listeners here. The observers below are NOT covered — neither
  // ResizeObserver nor MutationObserver accepts one — so they keep their explicit disconnects.
  const listeners = new AbortController();
  const { signal } = listeners;

  const onResize = (): void => scheduleRelayout();
  window.addEventListener('resize', onResize, { signal });

  let resizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => scheduleRelayout());
    resizeObserver.observe(hud);
  }

  const minObserver = new MutationObserver(() => scheduleRelayout());
  minObserver.observe(overlay, {
    attributes: true,
    attributeFilter: [MIN_ATTR, CHAT_ATTR, SETTINGS_ATTR],
  });

  const onVisualViewportResize = (): void => scheduleRelayout();
  window.visualViewport?.addEventListener('resize', onVisualViewportResize, { signal });
  window.visualViewport?.addEventListener('scroll', onVisualViewportResize, { signal });

  return (): void => {
    listeners.abort();
    resizeObserver?.disconnect();
    minObserver.disconnect();
  };
}

/**
 * Drag the presenter HUD by its header. Returns a teardown that removes listeners.
 * Uses pointer capture so the drag stays smooth even when the cursor leaves the head.
 */
export function installHudDrag(
  hud: HTMLElement,
  head: HTMLElement,
  callbacks: HudDragCallbacks = {},
): () => void {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let moved = false;
  let activePointerId: number | undefined;

  const finishDrag = (): void => {
    const didMove = moved;
    dragging = false;
    head.classList.remove(DRAG_HANDLE_DRAGGING_CLASS);
    activePointerId = undefined;
    moved = false;
    if (didMove) {
      const overlay = hud.parentElement;
      if (overlay instanceof HTMLElement) scheduleSyncDockLayout(hud, overlay);
      else relayoutHudPosition(hud);
    }
    callbacks.onDragEnd?.(didMove);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(HUD_DRAG_IGNORE_SEL) !== null) return;

    const rect = hud.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    dragging = true;
    moved = false;
    activePointerId = e.pointerId;
    head.classList.add(DRAG_HANDLE_DRAGGING_CLASS);
    if ('function' === typeof head.setPointerCapture) head.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging || e.pointerId !== activePointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) < HUD_DRAG_THRESHOLD_PX && Math.abs(dy) < HUD_DRAG_THRESHOLD_PX)
      return;
    moved = true;
    callbacks.onDragMove?.();
    const box = hudLayoutBox(hud);
    const next = clampHudPosition(
      startLeft + dx,
      startTop + dy,
      box.width,
      box.height,
      window.innerWidth,
      window.innerHeight,
    );
    applyHudPosition(hud, next.left, next.top);
    e.preventDefault();
  };

  const releaseCapture = (pointerId: number): void => {
    if ('function' === typeof head.releasePointerCapture) head.releasePointerCapture(pointerId);
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!dragging || e.pointerId !== activePointerId) return;
    if (moved) e.preventDefault();
    releaseCapture(e.pointerId);
    finishDrag();
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (!dragging || e.pointerId !== activePointerId) return;
    releaseCapture(e.pointerId);
    finishDrag();
  };

  // All four pointer phases share one signal: they are added together and must come off
  // together, and a partial removal would leave a half-live drag.
  const listeners = new AbortController();
  const { signal } = listeners;
  head.addEventListener('pointerdown', onPointerDown, { signal });
  head.addEventListener('pointermove', onPointerMove, { signal });
  head.addEventListener('pointerup', onPointerUp, { signal });
  head.addEventListener('pointercancel', onPointerCancel, { signal });

  return (): void => {
    listeners.abort();
    if (dragging) releaseCapture(activePointerId ?? 0);
    finishDrag();
  };
}

/**
 * Drag the presenter HUD from multiple handles (FAB when collapsed, toolbar brand when expanded).
 * Returns a teardown that removes listeners from every handle.
 */
export function installHudDragHandles(
  hud: HTMLElement,
  handles: HTMLElement[],
  callbacks: HudDragCallbacks = {},
): () => void {
  const teardowns = handles.map((handle) => installHudDrag(hud, handle, callbacks));
  return (): void => {
    for (const teardown of teardowns) teardown();
  };
}
