/**
 * Opaque-shell mode for metric #7 ("which works against opaque React shells?").
 *
 *   ?opaque=1   strip every data-testid  (the anchor devs add for testing)
 *   ?opaque=2   also strip role + aria-label  (kill the a11y fallback too)
 *
 * This simulates the real-world opaque React app: no test ids, generic/hashed markup, thin
 * semantics — the case where DOM-selector tools lose their grip. Reticle's dev-only source
 * stamps (data-reticle-source, added by the babel plugin) are LEFT intact: that is the whole
 * point — Reticle can still anchor a DOM element to its React component:file:line, and read the
 * store via reticle_state, when the visible DOM gives a selector-based tool nothing to grab.
 *
 * Dev-only; never imported in production. Runs continuously (MutationObserver) so React re-renders
 * can't restore the stripped attributes.
 */

const OPAQUE_PARAM = 'opaque';
const STRIP_LEVEL1 = ['data-testid'];
const STRIP_LEVEL2 = ['data-testid', 'role', 'aria-label', 'aria-labelledby'];

export function installOpaqueShell(): void {
  const level = new URLSearchParams(window.location.search).get(OPAQUE_PARAM);
  if (level === null || level.length === 0) return;
  const attrs = level === '2' ? STRIP_LEVEL2 : STRIP_LEVEL1;

  const strip = (): void => {
    for (const attr of attrs) {
      // Never touch Reticle's own instrumentation (data-reticle-*) — only app-authored attributes.
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        if (attr.startsWith('data-reticle')) continue;
        el.removeAttribute(attr);
      }
    }
  };
  strip();
  new MutationObserver(strip).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: attrs,
  });
}
