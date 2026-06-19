/**
 * Dev-only HARD-bug injector — the difficult, UI-level regressions for the stress benchmark. Unlike
 * iris-regress.ts (which strips testids / kills handlers), these leave the element fully PRESENT in
 * the DOM with the correct role + accessible name, so a structural or a11y-tree tool reports
 * everything fine. Only reading computed style / geometry — or hovering and comparing — reveals the
 * break. This is the data that separates "the element exists" from "a user can actually use it."
 *
 *   ?iris-bug=<id>[,<id>...]
 *
 * Catalog (each targets a known testid; the element stays in the DOM, correctly labelled):
 *   cursor-missing   — an interactive control loses cursor:pointer (looks dead to the mouse).
 *   invisible        — opacity:0: present, focusable, occupies layout, but the user sees nothing.
 *   zero-size        — collapsed to 0×0 (overflow hidden): in the a11y tree, unclickable in reality.
 *   occluded         — a transparent overlay sits on top (z-index): clicks hit the overlay, not it.
 *   color-regression — the primary action's color silently changed (a baseline-diff visual bug).
 *
 * State/UI desync (the capability gap — needs the app's STATE as source of truth, unreachable from
 * the DOM alone). Two distinct instances, so this is a CLASS of Iris-only catches, not one case:
 *   state-desync  — a COUNT lies: the Deployments nav badge is forced to 0 while the store holds the
 *                   real count. A number on screen looks plausible; only the store proves it wrong.
 *   status-stale  — a STATUS lies: the top deployment row shows a different status than the store
 *                   holds (a failed/in-flight deploy rendered as "live"). The pill is fully
 *                   self-consistent — right color, right dot — so a screenshot/a11y tool sees a
 *                   healthy deploy. Only reading the store reveals the deploy did not actually ship.
 *
 * Tree-shaken out of production; never imported there.
 */

import { useApp } from './store/store.js';

const BUG_PARAM = 'iris-bug';
const STYLE_ID = 'iris-hard-bug-style';
const OVERLAY_ID = 'iris-hard-bug-overlay';

/** CSS selector for a testid (also matches the parked attr so a bug survives the iris-break injector). */
function sel(testid: string): string {
  return `[data-testid="${testid}"]`;
}

/** Each bug → the CSS rule(s) it injects. The target testid is fixed per bug for a stable benchmark. */
const CSS_BUGS: Record<string, string> = {
  // An interactive nav control that no longer signals interactivity to the pointer.
  'cursor-missing': `${sel('nav-compose')}{cursor:default !important;}`,
  // Present + focusable + laid out, but visually gone — the classic "it's there in the DOM" trap.
  invisible: `${sel('new-deploy')}{opacity:0 !important;}`,
  // Collapsed to nothing: a11y tree still lists it; a real click can never land.
  'zero-size': `${sel('new-deploy')}{width:0 !important;height:0 !important;padding:0 !important;border:0 !important;overflow:hidden !important;}`,
  // The primary action silently recolored — invisible to structure, caught only vs a visual baseline.
  'color-regression': `${sel('new-deploy')}{background:#dc2626 !important;background-color:#dc2626 !important;background-image:none !important;}`,
  // Off-design-token color: renders fine, but the hex is not in the app's palette (--accent etc.).
  // Catching it needs to know the THEME — not just that a color rendered. The brand text goes
  // hot-magenta, a value no design token uses.
  'theme-violation': `${sel('brand')}{color:#ff00ff !important;}`,
};

/**
 * State/UI desync — the capability gap. The store holds the real deployment count
 * (store.deployments.length), rendered as the Deployments nav badge. This forces the BADGE to a
 * wrong value while the store is untouched: the UI lies about the truth. A tool that only sees the
 * DOM reads a plausible number and cannot know it's wrong; only reading the app's state
 * (iris_state — the store the app registered with Iris) reveals the mismatch. Re-applied on every
 * render so React can't restore the real count.
 */
const DESYNC_FAKE_COUNT = '0';
function installStateDesync(): void {
  const apply = (): void => {
    const badge = document.querySelector('[data-testid="nav-deployments"] .nav-badge');
    if (badge !== null && badge.textContent !== DESYNC_FAKE_COUNT) {
      badge.textContent = DESYNC_FAKE_COUNT;
    }
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

/**
 * Status desync — a per-entity STATUS lies (the second, harder desync instance). The top deployment
 * row (`deployments[0]`, always rendered) has its status pill forced to a value the store does NOT
 * hold — preferring the reassuring "live" so it reads as "a failed/in-flight deploy looks healthy".
 * The pill stays fully consistent (correct tone class + dot), so a screenshot or a11y-tree tool sees
 * a green, shipped deploy. The store keeps the true status; only `iris_state` reveals the lie. The
 * injector reads the store to pick a guaranteed-different display value, so the mismatch is
 * deterministic regardless of the seed. Re-applied on every render so React can't restore the truth.
 */
const STATUS_DESYNC_ROW_ID = 4000;
const STATUS_TONE: Record<string, string> = {
  live: 'badge-success',
  building: 'badge-info',
  queued: 'badge-warning',
  failed: 'badge-danger',
};
function installStatusDesync(): void {
  const apply = (): void => {
    const real = useApp.getState().deployments[0]?.status;
    if (real === undefined) return;
    const lie = real === 'live' ? 'failed' : 'live';
    const tone = STATUS_TONE[lie];
    const row = document.querySelector(`[data-testid="row-${String(STATUS_DESYNC_ROW_ID)}"]`);
    if (row === null) return;
    const badge = [...row.querySelectorAll('.badge')].find((b) => b.querySelector('.dot') !== null);
    if (!(badge instanceof HTMLElement)) return;
    const textNode = [...badge.childNodes].find(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
    );
    if (textNode !== undefined && textNode.textContent !== lie) textNode.textContent = lie;
    const className = `badge ${tone ?? ''}`.trim();
    if (badge.className !== className) badge.className = className;
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

/** Inject a transparent overlay covering the target so pointer hits land on the overlay, not it. */
function installOcclusion(): void {
  const apply = (): void => {
    const target = document.querySelector(sel('new-deploy'));
    if (target === null || document.getElementById(OVERLAY_ID) !== null) return;
    const rect = target.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:99999;background:transparent;`;
    document.body.appendChild(overlay);
  };
  // Re-apply after render + on resize so the overlay tracks the target.
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  apply();
}

/** Append the combined CSS for the active CSS-based bugs into one <style>. */
function installCss(bugs: ReadonlySet<string>): void {
  const rules = [...bugs].map((id) => CSS_BUGS[id]).filter((r): r is string => r !== undefined);
  if (rules.length === 0) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
}

/**
 * Install the hard-bug injector. No-op unless `?iris-bug=` is present. Each id degrades a present,
 * correctly-labelled element so only computed-style / geometry observation can catch it.
 */
export function installBugInjector(): void {
  const raw = new URLSearchParams(window.location.search).get(BUG_PARAM);
  if (raw === null || raw.length === 0) return;
  const bugs = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  installCss(bugs);
  if (bugs.has('occluded')) installOcclusion();
  if (bugs.has('state-desync')) installStateDesync();
  if (bugs.has('status-stale')) installStatusDesync();
}
