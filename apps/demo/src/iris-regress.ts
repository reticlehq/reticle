/**
 * Dev-only regression injector — the controlled "a developer broke it" knob for benchmarking
 * regression DETECTION. Reads a URL param and degrades the running app so a recorded flow that
 * used to pass now fails, exactly as a real code regression would. Tree-shaken out of production.
 *
 *   ?iris-break=new-deploy,deploy-submit   strip those data-testid attributes (selector regression)
 *
 * Stripping a data-testid is the most common real regression a flow hits: the element still renders
 * but the stable hook a test relied on is gone (renamed/removed in a refactor). A deterministic
 * replay must catch this as a TESTID_NOT_FOUND drift naming the missing anchor — not pass silently.
 */

const BREAK_PARAM = 'iris-break';
const TESTID_ATTR = 'data-testid';
const STRIPPED_ATTR = 'data-iris-stripped';

/** Strip data-testid from every element currently matching one of the broken ids (idempotent). */
function stripExisting(broken: ReadonlySet<string>): void {
  for (const id of broken) {
    for (const node of Array.from(document.querySelectorAll(`[${TESTID_ATTR}="${id}"]`))) {
      node.setAttribute(STRIPPED_ATTR, id);
      node.removeAttribute(TESTID_ATTR);
    }
  }
}

/**
 * Patch setAttribute so React can never (re)apply a broken data-testid — the value is rewritten to
 * the private parked attr instead. This wins the render race that a MutationObserver loses: the
 * broken hook is gone the instant React tries to set it, so a deterministic replay querying that
 * anchor sees zero matches on its very first query and drifts. Dev-only; no teardown needed.
 */
function patchSetAttribute(broken: ReadonlySet<string>): void {
  // Monkeypatching a prototype method is inherently this-dynamic; we forward `this` via .call below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string): void {
    if (name === TESTID_ATTR && broken.has(value)) {
      original.call(this, STRIPPED_ATTR, value);
      return;
    }
    original.call(this, name, value);
  };
}

/**
 * Install the regression injector. No-op unless `?iris-break=<testids>` is present. Strips any
 * already-rendered matches, then blocks all future writes of those testids — so the regression
 * holds for the whole session, synchronously, with no race against re-renders.
 */
export function installRegressions(): void {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(BREAK_PARAM);
  if (raw === null || raw.length === 0) return;
  const broken = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  if (broken.size === 0) return;
  patchSetAttribute(broken);
  stripExisting(broken);
}
