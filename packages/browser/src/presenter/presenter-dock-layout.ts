import {
  CHAT_ATTR,
  CHAT_PANEL_ATTR,
  CHAT_PLACEMENT_ATTR,
  DOCK_ALIGN_ATTR,
  DOCK_ATTR,
  HUD_DOCK_MARGIN_PX,
  Placement,
  SETTINGS_ATTR,
  SETTINGS_PANEL_ATTR,
  SETTINGS_PLACEMENT_ATTR,
} from './presenter-config.js';
import {
  applyHudPosition,
  isHudDragged,
  readHudPosition,
  relayoutHudPosition,
} from './presenter-drag.js';

const HUD_ATTR = 'data-reticle-hud';
const DOCK_PANEL_GAP_PX = 8;
const DOCK_SETTINGS_GAP_PX = 12;
const HUD_BAR_HEIGHT_PX = 44;
const CHAT_MIN_HEIGHT_PX = 160;
const CHAT_DEFAULT_MAX_HEIGHT_PX = 420;
const SETTINGS_DEFAULT_MAX_HEIGHT_PX = 520;
const SETTINGS_MIN_HEIGHT_PX = 200;

type Rect = { left: number; top: number; right: number; bottom: number };

function unionRects(rects: Rect[]): Rect | undefined {
  if (0 === rects.length) return undefined;
  let left = rects[0]?.left ?? 0;
  let top = rects[0]?.top ?? 0;
  let right = rects[0]?.right ?? 0;
  let bottom = rects[0]?.bottom ?? 0;
  for (const rect of rects.slice(1)) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return { left, top, right, bottom };
}

function pickVerticalPlacement(
  spaceAbove: number,
  spaceBelow: number,
  needPx: number,
): (typeof Placement)[keyof typeof Placement] {
  if (spaceAbove >= needPx) return Placement.ABOVE;
  if (spaceBelow >= needPx) return Placement.BELOW;
  return spaceBelow > spaceAbove ? Placement.BELOW : Placement.ABOVE;
}

function availableHeight(
  placement: (typeof Placement)[keyof typeof Placement],
  spaceAbove: number,
  spaceBelow: number,
  gapPx: number,
): number {
  const raw = Placement.ABOVE === placement ? spaceAbove - gapPx : spaceBelow - gapPx;
  return Math.max(0, raw);
}

function setMaxHeight(el: HTMLElement, cssVar: string, px: number): void {
  const pxText = `${String(px)}px`;
  el.style.setProperty(cssVar, pxText);
  el.style.maxHeight = pxText;
}

function clearMaxHeight(el: HTMLElement, cssVar: string): void {
  el.style.removeProperty(cssVar);
  el.style.removeProperty('max-height');
}

function visiblePanel(el: HTMLElement | null): el is HTMLElement {
  if (null === el) return false;
  const style = window.getComputedStyle(el);
  return 'none' !== style.display && 'hidden' !== style.visibility;
}

/** Resolve the HUD bar inside a dock (or the node itself in minimal fixtures). */
function resolveHudBar(dock: HTMLElement): HTMLElement | undefined {
  const nested = dock.querySelector(`[${HUD_ATTR}]`);
  if (nested instanceof HTMLElement) return nested;
  if (dock.hasAttribute(HUD_ATTR)) return dock;
  if (isHudDragged(dock)) return dock;
  return undefined;
}

/** Flip floating panels and reclamp a dragged dock so everything stays on-screen. */
export function syncDockLayout(dock: HTMLElement, overlay: HTMLElement): void {
  const hud = resolveHudBar(dock);
  if (hud === undefined) return;

  const chatOpen = '1' === overlay.getAttribute(CHAT_ATTR);
  const settingsOpen = '1' === overlay.getAttribute(SETTINGS_ATTR);
  const chatPanel = dock.querySelector(`[${CHAT_PANEL_ATTR}]`);
  const settingsPanel = dock.querySelector(`[${SETTINGS_PANEL_ATTR}]`);
  const margin = HUD_DOCK_MARGIN_PX;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const hudRect = hud.getBoundingClientRect();
  const spaceAbove = hudRect.top - margin;
  const spaceBelow = viewportH - hudRect.bottom - margin;

  if (chatOpen && chatPanel instanceof HTMLElement && visiblePanel(chatPanel)) {
    const chatHeight = chatPanel.getBoundingClientRect().height || CHAT_DEFAULT_MAX_HEIGHT_PX;
    const placement = pickVerticalPlacement(spaceAbove, spaceBelow, chatHeight + DOCK_PANEL_GAP_PX);
    dock.setAttribute(CHAT_PLACEMENT_ATTR, placement);
    const maxH = Math.min(
      CHAT_DEFAULT_MAX_HEIGHT_PX,
      Math.max(
        CHAT_MIN_HEIGHT_PX,
        availableHeight(placement, spaceAbove, spaceBelow, DOCK_PANEL_GAP_PX),
      ),
    );
    setMaxHeight(chatPanel, '--reticle-chat-max-h', maxH);
  } else {
    dock.removeAttribute(CHAT_PLACEMENT_ATTR);
    if (chatPanel instanceof HTMLElement) clearMaxHeight(chatPanel, '--reticle-chat-max-h');
  }

  if (settingsOpen && settingsPanel instanceof HTMLElement && visiblePanel(settingsPanel)) {
    const settingsHeight =
      settingsPanel.getBoundingClientRect().height || SETTINGS_DEFAULT_MAX_HEIGHT_PX;
    const placement = pickVerticalPlacement(
      spaceAbove,
      spaceBelow,
      settingsHeight + HUD_BAR_HEIGHT_PX + DOCK_SETTINGS_GAP_PX,
    );
    dock.setAttribute(SETTINGS_PLACEMENT_ATTR, placement);
    const maxH = Math.min(
      SETTINGS_DEFAULT_MAX_HEIGHT_PX,
      Math.max(
        SETTINGS_MIN_HEIGHT_PX,
        availableHeight(placement, spaceAbove, spaceBelow, DOCK_SETTINGS_GAP_PX),
      ),
    );
    setMaxHeight(settingsPanel, '--reticle-settings-max-h', maxH);
  } else {
    dock.removeAttribute(SETTINGS_PLACEMENT_ATTR);
    if (settingsPanel instanceof HTMLElement) {
      clearMaxHeight(settingsPanel, '--reticle-settings-max-h');
    }
  }

  const panelWidth = Math.max(
    chatOpen && chatPanel instanceof HTMLElement ? chatPanel.getBoundingClientRect().width : 0,
    settingsOpen && settingsPanel instanceof HTMLElement
      ? settingsPanel.getBoundingClientRect().width
      : 0,
  );
  if (chatOpen || settingsOpen) {
    const panelLeft = hudRect.right - panelWidth;
    const panelRight = hudRect.left + panelWidth;
    if (panelLeft < margin || hudRect.left < margin) {
      dock.setAttribute(DOCK_ALIGN_ATTR, 'start');
    } else if (panelRight > viewportW - margin || hudRect.right > viewportW - margin) {
      dock.setAttribute(DOCK_ALIGN_ATTR, 'end');
    } else {
      dock.setAttribute(DOCK_ALIGN_ATTR, 'end');
    }
  } else {
    dock.removeAttribute(DOCK_ALIGN_ATTR);
  }

  if (!chatOpen && !settingsOpen) {
    if (isHudDragged(dock)) relayoutHudPosition(dock);
    return;
  }

  const tracked: Rect[] = [hudRect];
  if (chatOpen && chatPanel instanceof HTMLElement && visiblePanel(chatPanel)) {
    tracked.push(chatPanel.getBoundingClientRect());
  }
  if (settingsOpen && settingsPanel instanceof HTMLElement && visiblePanel(settingsPanel)) {
    tracked.push(settingsPanel.getBoundingClientRect());
  }
  const bounds = unionRects(tracked);
  if (bounds === undefined) return;

  let dx = 0;
  let dy = 0;
  if (bounds.left < margin) dx = margin - bounds.left;
  else if (bounds.right > viewportW - margin) dx = viewportW - margin - bounds.right;
  if (bounds.top < margin) dy = margin - bounds.top;
  else if (bounds.bottom > viewportH - margin) dy = viewportH - margin - bounds.bottom;

  if (0 === dx && 0 === dy) return;

  const dockRect = dock.getBoundingClientRect();
  const base = isHudDragged(dock)
    ? readHudPosition(dock)
    : { left: dockRect.left, top: dockRect.top };
  applyHudPosition(dock, base.left + dx, base.top + dy);
}

let syncRafId: number | undefined;

/** Batch dock layout work on the next frame (resize, panel open, drag end). */
export function scheduleSyncDockLayout(dock: HTMLElement, overlay: HTMLElement): void {
  if (syncRafId !== undefined) cancelAnimationFrame(syncRafId);
  syncRafId = requestAnimationFrame(() => {
    syncRafId = undefined;
    syncDockLayout(dock, overlay);
    requestAnimationFrame(() => syncDockLayout(dock, overlay));
  });
}

/** Resolve the dock node from an overlay root. */
export function findDock(overlay: HTMLElement): HTMLElement | undefined {
  const dock = overlay.querySelector(`[${DOCK_ATTR}]`);
  return dock instanceof HTMLElement ? dock : undefined;
}
