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
 * Tree-shaken out of production; never imported there.
 */

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
};

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
export function installHardBugs(): void {
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
}
