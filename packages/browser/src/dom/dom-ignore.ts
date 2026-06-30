/** Selectors for Reticle's own presenter overlay (cursor, HUD, glow) — never observed/snapshotted. */
const RETICLE_OVERLAY =
  '[data-reticle-overlay],[data-reticle-cursor],[data-reticle-hud],[data-reticle-glow]';

/** Known third-party dev overlays to keep out of snapshots (Agentation, Next dev UI). */
const DEV_OVERLAYS =
  '[data-agentation],#__next-build-watcher,nextjs-portal,[data-nextjs-dialog],[data-nextjs-toast]';

let extraIgnore = '';

/** Let the host app add selectors to exclude from snapshots (e.g. its own dev widgets). */
export function setIgnoreSelectors(selectors: string[]): void {
  extraIgnore = selectors.join(',');
}

/** True if the element is part of Reticle's own presenter overlay. */
export function isReticleOverlay(el: Element): boolean {
  return el.closest(RETICLE_OVERLAY) !== null;
}

/** True if the element should be excluded from snapshots/queries (Reticle overlay or dev overlay). */
export function isIgnored(el: Element): boolean {
  const sel =
    extraIgnore.length > 0
      ? `${RETICLE_OVERLAY},${DEV_OVERLAYS},${extraIgnore}`
      : `${RETICLE_OVERLAY},${DEV_OVERLAYS}`;
  return el.closest(sel) !== null;
}
