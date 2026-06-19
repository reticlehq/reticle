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
 * Performance (needs the React commit stream — invisible to a DOM tool):
 *   render-storm  — re-renders `series` subscribers ~60×/s with identical output: React commits
 *                   every tick but the DOM never mutates. Only iris_state __iris_renders sees it.
 *
 * Network cardinality (the request fired, but the WRONG number of times):
 *   double-submit — the Compose action fires `POST /api/generate-script` TWICE. One result renders, so
 *                   the UI looks right and a presence assertion ("a POST fired") passes. Only a
 *                   `net.count:1` consequence catches the duplicate.
 *   console-leak  — the Compose action logs a `console.error` while the UI still renders the result.
 *                   A structural/visual check passes; only a clean-console consequence catches it.
 *   forbidden-call — the Compose action calls a FORBIDDEN endpoint (`/api/legacy-telemetry`) it must
 *                   never hit (reverted migration / privacy beacon / N+1). Only a `net { count:0 }`
 *                   consequence ("this must never fire") catches it; nothing visible changes.
 *   mutation-leak — the BLAST RADIUS: the Compose action also corrupts an UNRELATED store path (the top
 *                   deployment's status). Nothing visible changes; only a state invariant (the unrelated
 *                   path stayed put) catches the over-reaching side-effect — no DOM tool can.
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
  // A PAINT-level regression (the reverse case — Playwright/screenshot territory): a stray filter
  // re-tints the entire rendered output. iris_inspect's element props (color/backgroundColor/opacity/
  // box/cursor) are UNCHANGED — the declared values still apply; the filter only alters the painted
  // pixels — so the always-on computed-style read misses it. Only a screenshot-diff sees it.
  'paint-filter': `html{filter:hue-rotate(90deg) saturate(1.6) !important;}`,
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

/**
 * Wasted-render storm — the perf regression no DOM tool can see. Every ~16ms we replace `series` with
 * a NEW array of the SAME values: every component subscribed to it re-renders (~60×/s), but the
 * rendered output is identical, so React reconciles to no DOM mutation. A screenshot/DOM tool sees a
 * perfectly idle page; only the React commit meter (iris_state __iris_renders) sees the storm.
 */
function installRenderStorm(): void {
  setInterval(() => {
    useApp.setState((s) => ({ series: [...s.series] }));
  }, 16);
}

/**
 * Double-submit — a NETWORK-cardinality regression no presence check can see. The Compose action is
 * supposed to fire exactly ONE `POST /api/generate-script`; this wraps fetch so that request goes out
 * TWICE (the classic double-submit / useEffect-double-fire / retry-storm bug). The UI looks identical —
 * one result renders — and a presence assertion ("a POST fired") still passes. Only a `net.count:1`
 * consequence catches it. Installed AFTER the Iris SDK has patched fetch (see main.tsx order), so the
 * duplicate is observed by the network buffer; the duplicate is fire-and-forget (errors swallowed) so
 * it never breaks the app.
 */
const DOUBLE_SUBMIT_PATH = '/api/generate-script';
function installDoubleSubmit(): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method === 'POST' && url.includes(DOUBLE_SUBMIT_PATH)) {
      void origFetch(input, init).catch(() => undefined);
    }
    return origFetch(input, init);
  };
}

/**
 * Forbidden-call — the NEGATIVE cardinality regression: an action calls an endpoint it must NOT. The
 * classic shapes are a reverted API migration (something starts calling the legacy endpoint again), an
 * analytics/telemetry beacon sneaking onto a privacy-sensitive screen, or an N+1 fan-out. Nothing
 * visible changes — the request just goes out. The Compose action fires a forbidden POST to
 * `/api/legacy-telemetry`; only a `net { urlContains, count: 0 }` consequence ("this must never fire")
 * catches it. Synchronous on the click + through the Iris-patched fetch, so it's observed; fire-and-forget.
 */
const FORBIDDEN_CALL_PATH = '/api/legacy-telemetry';
function installForbiddenCall(): void {
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element) || target.closest(sel('compose-generate')) === null) return;
      void window.fetch(FORBIDDEN_CALL_PATH, { method: 'POST', body: '{}' }).catch(() => undefined);
    },
    true,
  );
}

/**
 * Mutation-leak — the BLAST-RADIUS regression: an action over-reaches and mutates store state it has
 * no business touching. Here the Compose action (which should only set compose.result) ALSO, as an
 * unintended side-effect, corrupts the top deployment's status in the store. The Compose UI looks
 * perfect, the Deployments view isn't even on screen — so a DOM/visual tool sees nothing wrong. Only
 * asserting that the UNRELATED store path stayed put (a state invariant) catches the leak. No
 * out-of-page tool can make that assertion at all; it needs the program's own state.
 */
function installMutationLeak(): void {
  // Fire synchronously on the Compose action's click (capture phase), so the unintended store write is
  // present the moment the action runs — independent of the async POST. The Deployments view isn't
  // rendered, so this produces no DOM mutation: invisible to any out-of-page tool, visible only in state.
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element) || target.closest(sel('compose-generate')) === null) return;
      const deps = useApp.getState().deployments;
      const head = deps[0];
      if (head !== undefined && head.status !== 'failed') {
        useApp.setState({
          deployments: deps.map((d, i) => (i === 0 ? { ...d, status: 'failed' } : d)),
        });
      }
    },
    true,
  );
}

/**
 * Console-leak — a regression that logs a `console.error` on an action while the UI still works. The
 * Compose action renders its result fine, but a (simulated) caught error / unhandled rejection surfaces
 * on the console — exactly the "it works but the log is screaming" regression a structural or visual
 * check sails past. A clean-console success consequence (console { absent:true }) catches it. Fires
 * AFTER the action's own handler (a capture-phase listener + a microtask) so the error lands in the
 * window the success oracle reads.
 */
const CONSOLE_LEAK_TESTID = 'compose-generate';
function installConsoleLeak(): void {
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (target instanceof Element && target.closest(sel(CONSOLE_LEAK_TESTID)) !== null) {
        setTimeout(() => {
          console.error(
            '[regression] generate(): unhandled rejection while formatting release note',
          );
        }, 0);
      }
    },
    true,
  );
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
  if (bugs.has('render-storm')) installRenderStorm();
  if (bugs.has('double-submit')) installDoubleSubmit();
  if (bugs.has('console-leak')) installConsoleLeak();
  if (bugs.has('mutation-leak')) installMutationLeak();
  if (bugs.has('forbidden-call')) installForbiddenCall();
}
