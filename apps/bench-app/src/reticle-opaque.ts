/**
 * Opaque-shell mode for metric #7 ("which works against opaque React shells?").
 *
 * ?opaque=1 strip every data-testid (the anchor devs add for testing)
 * ?opaque=2 also strip role + aria-label (kill the a11y fallback too)
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
/**
 * `?nosource=1` strips the babel plugin's `data-reticle-source` stamps.
 *
 * The INVERSE of opaque mode, and it exists for one reason: to run Reticle against itself. Every
 * other condition in the suite compares Reticle to another tool; this one compares Reticle WITH the
 * file:line pointer against Reticle WITHOUT it, holding detection, tooling and the app constant. It
 * is the only way to attribute a change in an agent's behaviour to the pointer rather than to
 * everything else Reticle does.
 *
 * Deliberately does not disable the observers or any tool — only the stamp an agent reads back.
 */
const NO_SOURCE_PARAM = 'nosource';
const SOURCE_ATTR = 'data-reticle-source';
const STRIP_LEVEL1 = ['data-testid'];
const STRIP_LEVEL2 = ['data-testid', 'role', 'aria-label', 'aria-labelledby'];

/**
 * Strip source stamps continuously, so a React re-render cannot restore what the ablation removed.
 * Runs independently of opaque mode: the two knobs compose.
 */
export function installNoSource(): void {
  const params = new URLSearchParams(window.location.search);
  if (null === params.get(NO_SOURCE_PARAM)) return;

  const strip = (): void => {
    for (const el of document.querySelectorAll(`[${SOURCE_ATTR}]`)) {
      el.removeAttribute(SOURCE_ATTR);
    }
  };
  strip();
  new MutationObserver(strip).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [SOURCE_ATTR],
  });
}

export function installOpaqueShell(): void {
  const level = new URLSearchParams(window.location.search).get(OPAQUE_PARAM);
  if (null === level || 0 === level.length) return;
  const attrs = '2' === level ? STRIP_LEVEL2 : STRIP_LEVEL1;

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
