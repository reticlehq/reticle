import {
  HUD_DOCK_MARGIN_PX,
  HUD_DRAGGED_ATTR,
  HUD_POS_X_VAR,
  HUD_POS_Y_VAR,
} from './presenter-config.js';

/**
 * Where the HUD sits, read and written — and nothing about the gesture that moves it.
 *
 * A leaf. `presenter-dock-layout.ts` needs four of these to lay the dock out, and
 * `presenter-drag.ts` — which owns the pointer gesture — needs the dock layout to re-sync after a
 * drag. So the two files needed each other, over primitives that belong to neither.
 */

/** Whether the HUD is off the default bottom-right dock. */
export function isHudDragged(hud: HTMLElement): boolean {
  return '1' === hud.getAttribute(HUD_DRAGGED_ATTR);
}

/** Clamp a HUD position so the full panel stays inside the viewport. */
export function clampHudPosition(
  left: number,
  top: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = HUD_DOCK_MARGIN_PX,
): { left: number; top: number } {
  const minLeft = margin;
  const minTop = margin;
  const maxLeft = Math.max(minLeft, viewportWidth - width - margin);
  const maxTop = Math.max(minTop, viewportHeight - height - margin);
  return {
    left: Math.max(minLeft, Math.min(left, maxLeft)),
    top: Math.max(minTop, Math.min(top, maxTop)),
  };
}

/** Paint an explicit left/top position (switches the HUD off the default bottom-right dock). */
export function applyHudPosition(hud: HTMLElement, left: number, top: number): void {
  hud.setAttribute(HUD_DRAGGED_ATTR, '1');
  hud.style.setProperty(HUD_POS_X_VAR, `${String(left)}px`);
  hud.style.setProperty(HUD_POS_Y_VAR, `${String(top)}px`);
}

/** Return the HUD to the default bottom-right dock. */
export function resetHudDockPosition(hud: HTMLElement): void {
  hud.removeAttribute(HUD_DRAGGED_ATTR);
  hud.style.removeProperty(HUD_POS_X_VAR);
  hud.style.removeProperty(HUD_POS_Y_VAR);
}

/** Return the HUD's laid-out box (rounded to whole pixels for stable clamping). */
export function hudLayoutBox(hud: HTMLElement): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const rect = hud.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/** Read the dragged HUD's authored position (CSS vars), falling back to layout box. */
export function readHudPosition(hud: HTMLElement): { left: number; top: number } {
  const x = hud.style.getPropertyValue(HUD_POS_X_VAR);
  const y = hud.style.getPropertyValue(HUD_POS_Y_VAR);
  if (x !== '' && y !== '') {
    return { left: Number.parseFloat(x), top: Number.parseFloat(y) };
  }
  const rect = hud.getBoundingClientRect();
  return { left: rect.left, top: rect.top };
}

/**
 * Re-clamp a dragged HUD after resize, minimise/expand, or any layout-driven size change.
 * No-op when the panel is still on the default dock.
 */
export function relayoutHudPosition(hud: HTMLElement): void {
  if (!isHudDragged(hud)) return;
  const { left, top } = readHudPosition(hud);
  const { width, height } = hudLayoutBox(hud);
  const next = clampHudPosition(left, top, width, height, window.innerWidth, window.innerHeight);
  applyHudPosition(hud, next.left, next.top);
}
