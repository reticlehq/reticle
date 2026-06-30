/**
 * Dev-only regression injector — the controlled "a developer broke it" knob for benchmarking
 * regression DETECTION. Reads a URL param and degrades the running app so a recorded flow that
 * used to pass now fails, exactly as a real code regression would. Tree-shaken out of production.
 *
 *   ?reticle-break=new-deploy,deploy-submit   strip those data-testid attributes (selector regression)
 *
 * Stripping a data-testid is the most common real regression a flow hits: the element still renders
 * but the stable hook a test relied on is gone (renamed/removed in a refactor). A deterministic
 * replay must catch this as a TESTID_NOT_FOUND drift naming the missing anchor — not pass silently.
 */

const BREAK_PARAM = 'reticle-break';
const BREAK_CLICK_PARAM = 'reticle-break-click';
const TESTID_ATTR = 'data-testid';
const STRIPPED_ATTR = 'data-reticle-stripped';

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
 * Break the click HANDLER of an element while leaving it fully present in the DOM — the second
 * class of real regression: a refactor wires up the button but its onClick no longer does anything
 * (or throws before its effect), so the element renders, a locator resolves, the step "succeeds",
 * yet the feature is dead. A capture-phase listener on document fires before React's root-delegated
 * bubble handler and stops the event, so the handler never runs and its consequence never fires.
 * This is the regression a presence-only test (and a self-healed locator) passes green — only a
 * flow with a consequence oracle (assert-signal / assert-net / success-state) catches it.
 */
function installBrokenClicks(brokenClicks: ReadonlySet<string>): void {
  if (brokenClicks.size === 0) return;
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      for (const id of brokenClicks) {
        if (target.closest(`[${TESTID_ATTR}="${id}"]`) !== null) {
          event.stopImmediatePropagation();
          event.preventDefault();
          return;
        }
      }
    },
    true,
  );
}

/** Parse a comma-separated URL param into a set of trimmed, non-empty tokens. */
function parseSet(params: URLSearchParams, key: string): Set<string> {
  const raw = params.get(key);
  if (raw === null || raw.length === 0) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Install the regression injector. No-op unless a break param is present.
 *   ?reticle-break=<testids>        strip those data-testids (selector regression → testid drift)
 *   ?reticle-break-click=<testids>  kill those elements' click handlers (consequence regression →
 *                                element resolves green, but the success/signal oracle fails)
 */
export function installRegressions(): void {
  const params = new URLSearchParams(window.location.search);
  const broken = parseSet(params, BREAK_PARAM);
  if (broken.size > 0) {
    patchSetAttribute(broken);
    stripExisting(broken);
  }
  installBrokenClicks(parseSet(params, BREAK_CLICK_PARAM));
}
