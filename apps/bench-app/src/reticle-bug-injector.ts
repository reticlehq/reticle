/**
 * Dev-only HARD-bug injector — the difficult, intent-level regressions for the stress benchmark. Unlike
 * reticle-regress.ts (which strips testids / kills handlers), these leave the element fully PRESENT in
 * the DOM with the correct role + accessible name, so a structural or a11y-tree tool reports
 * everything fine. Only reading computed style / geometry, the network buffer, the console, or the
 * app's own STATE reveals the break. This is the data that separates "the element exists" from "a user
 * can actually use it, and the program did the right thing."
 *
 *   ?reticle-bug=<id>[,<id>...]
 *
 * The catalog is organised as a handful of generic installers driven by lookup tables, so a new bug is
 * one table row, not a new function:
 *
 *   CSS_BUGS      — a control loses interactivity/visibility via computed style (opacity:0, 0×0,
 *                   recolor) or the whole page is re-tinted (a paint-only regression). Caught by a
 *                   geometry/computed-style read (both tools) or a pixel diff (screenshot only).
 *   OCCLUDE       — a transparent overlay covers a control so clicks land on the overlay, not it.
 *   TAMPER        — an action writes store state it should not (blast radius) or writes a WRONG value
 *                   (a business-logic invariant: a KPI number, a created row's field). The corruption
 *                   is off-screen, so no DOM/pixel tool can see it; only reading the store proves it.
 *   CONSOLE_LEAKS — an action logs a console.error while the UI still renders fine.
 *   EXTRA_FETCH   — an action fires a request it must NOT (a forbidden endpoint / privacy beacon) or
 *                   fires its own request one extra time (double-submit). Caught by a network count.
 *   DOM_TEXT      — a displayed label/number is silently wrong (a mock-data / copy regression).
 *
 * Two always-on desync installers keep the DOM self-consistent while lying about the truth:
 *   state-desync  — the Deployments nav badge is forced to a wrong count while the store holds the real
 *                   one. Only reading the store reveals the mismatch.
 *   status-stale  — the top deployment row shows a status the store does NOT hold (a failed/in-flight
 *                   deploy rendered as "live"). The pill is fully self-consistent, so a screenshot/a11y
 *                   tool sees a healthy deploy; only the store reveals the lie.
 *   render-storm  — re-renders `series` subscribers ~60×/s with identical output: React commits every
 *                   tick but the DOM never mutates. Only the React commit meter sees it.
 *
 * Tree-shaken out of production; never imported there.
 */

import { useApp } from './store/store.js';
import type { Deployment } from './data/seed.js';

const BUG_PARAM = 'reticle-bug';
const STYLE_ID = 'reticle-hard-bug-style';
const API_BASE = 'http://localhost:8787';
const CONSOLE_MSG = '[regression] handler: unhandled rejection while formatting result';

/**
 * Plausible-but-wrong values a tamper writes into NEVER-RENDERED store paths. Each looks completely
 * ordinary — a normal cost figure, a normal build checksum, a normal deployment id — so ONLY comparing
 * it to the store's real/expected value reveals the corruption. Nothing here is self-labelling: a DOM
 * or pixel tool that somehow saw the value would see nothing suspicious. Chosen to differ from every
 * seeded value (costs 1200/1215…, checksums 9a3f0x…, new-row checksum 2328, new-row cost 0) and from
 * the seeded deployment ids (3961–4000), so the write is always a real change and the phantom id
 * highlights/opens nothing on screen.
 */
const WRONG_COST = 4200;
const WRONG_CHECKSUM = 'b7c9d10';
const PHANTOM_DEPLOY_ID = 3800;

/** CSS selector for a testid. The target testid is fixed per bug for a stable benchmark. */
function sel(testid: string): string {
  return `[data-testid="${testid}"]`;
}

/** Collapse a control to 0×0 (present in the a11y tree, unclickable in reality). */
function collapse(testid: string): string {
  return `${sel(testid)}{width:0 !important;height:0 !important;padding:0 !important;border:0 !important;overflow:hidden !important;}`;
}
/** Make a control fully transparent (present, focusable, laid out, but the user sees nothing). */
function fade(testid: string): string {
  return `${sel(testid)}{opacity:0 !important;}`;
}

/** Each CSS bug → the rule(s) it injects. Visual/geometry regressions that leave the element present. */
const CSS_BUGS: Record<string, string> = {
  // An interactive nav control that no longer signals interactivity to the pointer (neither harness
  // inspects cursor, so this ships in the injector but is not scored — kept for manual demos).
  'cursor-missing': `${sel('nav-compose')}{cursor:default !important;}`,
  // The primary action silently recolored / off-token — visible only vs a baseline (no color oracle in
  // the fixed check vocabulary, so these are demo-only, not registered).
  'color-regression': `${sel('new-deploy')}{background:#dc2626 !important;background-color:#dc2626 !important;background-image:none !important;}`,
  'theme-violation': `${sel('brand')}{color:#ff00ff !important;}`,

  // Present + laid out, but visually gone — the classic "it's there in the DOM" trap.
  invisible: fade('new-deploy'),
  'nav-compose-invisible': fade('nav-compose'),
  'nav-overview-invisible': fade('nav-overview'),
  'nav-deployments-invisible': fade('nav-deployments'),
  'cmdk-invisible': fade('cmdk-open'),
  'env-filter-invisible': fade('env-filter'),
  'login-invisible': fade('login-submit'),

  // Collapsed to nothing: a11y tree still lists it; a real click can never land.
  'zero-size': collapse('new-deploy'),
  'nav-overview-collapsed': collapse('nav-overview'),
  'nav-diagnostics-collapsed': collapse('nav-diagnostics'),
  'cmdk-collapsed': collapse('cmdk-open'),
  'env-filter-collapsed': collapse('env-filter'),
  'login-collapsed': collapse('login-submit'),

  // PAINT-level regressions (screenshot territory): a stray filter re-tints the whole rendered output.
  // Computed element props (color/backgroundColor/opacity/box) are UNCHANGED — the filter only alters
  // painted pixels — so a computed-style read misses it. Only a screenshot-diff sees it.
  'paint-filter': `html{filter:hue-rotate(90deg) saturate(1.6) !important;}`,
  'paint-invert': `html{filter:invert(1) hue-rotate(180deg) !important;}`,
};

/** Occlusion bugs → the control a transparent overlay is placed over. */
const OCCLUDE: Record<string, string> = {
  occluded: 'new-deploy',
  'nav-deployments-occluded': 'nav-deployments',
  'cmdk-occluded': 'cmdk-open',
};

/**
 * Store-tamper bugs. An action either writes a value it has no business touching (blast radius) or
 * writes a WRONG value (a business-logic invariant). Fired from the trigger control's click. `defer`
 * runs the write in a macrotask so it lands AFTER the action's own handler — needed when we corrupt the
 * value the action itself just produced (e.g. the freshly-created deployment row). The corrupted slice
 * is always off-screen for the acting view, so no DOM/pixel tool can observe it; only a state read can.
 */
interface Tamper {
  trigger: string;
  defer: boolean;
  run: () => void;
}
// Corrupt one field of the deployment at index `i`. EVERY *displayed* Deployment field is rendered
// somewhere — the deploy TABLE shows service/commit/env/status/region/duration, and the DETAIL DRAWER
// (openable from any row) additionally shows author/createdAt/id — so none of them is safe: a
// cross-navigating DOM agent can read them all. The only never-rendered fields are the internal
// `costUsd`/`checksum` (audited absent from all JSX; see seed.ts), so every tamper below writes one of
// those, or a top-level scalar (`selectedId`/`drawerId`) that has no textual rendering. The value is
// plausible, so only a store read — not a DOM/pixel read — can prove it wrong.
const setDep = (i: number, patch: Partial<Deployment>): (() => void) => (): void => {
  useApp.setState((s) => ({ deployments: s.deployments.map((d, idx) => (idx === i ? { ...d, ...patch } : d)) }));
};
const TAMPER: Record<string, Tamper> = {
  // --- Blast radius: an action mutates an UNRELATED, never-rendered store path (reticle-only) -------
  'mutation-leak': { trigger: 'compose-generate', defer: false, run: setDep(0, { checksum: WRONG_CHECKSUM }) },
  'generate-blast-filter': { trigger: 'compose-generate', defer: false, run: setDep(0, { costUsd: WRONG_COST }) },
  'generate-blast-selected': {
    trigger: 'compose-generate',
    defer: false,
    // A phantom id: selectedId only drives a row's `.sel` class, and this id matches no seeded row, so
    // nothing highlights — same as the clean (null) build. Only the store reveals the stray write.
    run: () => useApp.setState({ selectedId: PHANTOM_DEPLOY_ID }),
  },
  'generate-blast-drawer': {
    trigger: 'compose-generate',
    defer: false,
    // drawerId opens the detail drawer only when it matches a deployment; a phantom id opens nothing,
    // so the DOM is identical to clean. Only the store shows the drawer was "opened" in state.
    run: () => useApp.setState({ drawerId: PHANTOM_DEPLOY_ID }),
  },
  'nav-blast-prompt': { trigger: 'nav-diagnostics', defer: false, run: setDep(0, { checksum: WRONG_CHECKSUM }) },
  'nav-blast-title': { trigger: 'nav-diagnostics', defer: false, run: setDep(0, { costUsd: WRONG_COST }) },
  'newdeploy-blast-kpi': { trigger: 'new-deploy', defer: false, run: setDep(0, { costUsd: WRONG_COST }) },

  // --- Business-logic invariant: the action produces a WRONG never-rendered value (reticle-only) ---
  // An unrelated Compose action corrupts an internal field of a deployment; the field renders nowhere,
  // so the wrong value never shows — only a store read proves the invariant broken.
  'kpi-deploys-tamper': { trigger: 'compose-generate', defer: false, run: setDep(0, { costUsd: WRONG_COST }) },
  'kpi-success-tamper': { trigger: 'compose-generate', defer: false, run: setDep(0, { checksum: WRONG_CHECKSUM }) },
  'kpi-p95-tamper': { trigger: 'compose-generate', defer: false, run: setDep(1, { costUsd: WRONG_COST }) },
  'kpi-services-tamper': { trigger: 'compose-generate', defer: false, run: setDep(1, { checksum: WRONG_CHECKSUM }) },
  // A freshly-created deployment gets a wrong internal cost/checksum in the store; neither renders in
  // the row or drawer, so the row looks correct while the record is wrong.
  'create-wrong-author': { trigger: 'deploy-submit', defer: true, run: setDep(0, { checksum: WRONG_CHECKSUM }) },
  'create-wrong-createdat': { trigger: 'deploy-submit', defer: true, run: setDep(0, { costUsd: WRONG_COST }) },
};

/** Console-leak bugs → the control whose click emits a console.error (UI still renders fine). */
const CONSOLE_LEAKS: Record<string, string> = {
  'console-leak': 'compose-generate',
  'console-leak-newdeploy': 'new-deploy',
  'console-leak-diagnostics': 'nav-diagnostics',
  'console-leak-cmdk': 'cmdk-open',
  'console-leak-env': 'env-filter',
  'console-leak-login': 'login-submit',
};

/**
 * Extra-fetch bugs. On the trigger's click, fire one more request. A FORBIDDEN url (a reverted API
 * migration, a privacy beacon, an N+1 fan-out) must never fire — a net count of 0 catches the extra.
 * A DOUBLE url is the action's own endpoint fired a second time — a net count of 1 catches the extra.
 */
interface ExtraFetch {
  trigger: string;
  url: string;
  method: 'GET' | 'POST';
}
const EXTRA_FETCH: Record<string, ExtraFetch> = {
  // Forbidden (must never fire; expected count 0).
  'forbidden-call': { trigger: 'compose-generate', url: '/api/legacy-telemetry', method: 'POST' },
  'forbidden-500-newdeploy': {
    trigger: 'new-deploy',
    url: `${API_BASE}/api/broken/500`,
    method: 'GET',
  },
  'login-beacon': { trigger: 'login-submit', url: '/api/legacy-telemetry', method: 'POST' },
  'nav-beacon': { trigger: 'nav-overview', url: '/api/legacy-telemetry', method: 'POST' },
  'compose-cors-leak': {
    trigger: 'compose-generate',
    url: `${API_BASE}/api/broken/cors`,
    method: 'GET',
  },
  // Double (the action's own request fired twice; expected count 1).
  'double-submit': {
    trigger: 'compose-generate',
    url: `${API_BASE}/api/generate-script`,
    method: 'POST',
  },
  'double-login': { trigger: 'login-submit', url: `${API_BASE}/api/login`, method: 'POST' },
  'double-fault-500': {
    trigger: 'fault-500',
    url: `${API_BASE}/api/broken/500`,
    method: 'GET',
  },
};

/** DOM-text bugs → a testid whose displayed label/number is silently overwritten with a wrong value. */
const DOM_TEXT: Record<string, { testid: string; wrong: string }> = {
  'brand-typo': { testid: 'brand', wrong: 'Retcile mission control' },
  'session-pill-typo': { testid: 'session-pill', wrong: 'Agent offline' },
  'console-count-lie': { testid: 'console-count', wrong: '7 err' },
  'nav-label-typo': { testid: 'nav-compose', wrong: 'Composr' },
};

/**
 * State/UI desync — the store holds the real deployment count (deployments.length), rendered as the
 * Deployments nav badge. This forces the BADGE to a wrong value while the store is untouched: the UI
 * lies. Only reading the app's state reveals the mismatch. Re-applied on every render.
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
 * Status desync — the top deployment row (deployments[0], always rendered) has its status pill forced
 * to a value the store does NOT hold, preferring the reassuring "live". The pill stays self-consistent
 * (correct tone class + dot), so a screenshot/a11y-tree tool sees a healthy deploy. Only a state read
 * reveals the lie. The injector reads the store to pick a guaranteed-different value.
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
 * Wasted-render storm — every ~16ms we replace `series` with a NEW array of the SAME values: every
 * component subscribed to it re-renders (~60×/s), but the rendered output is identical, so React
 * reconciles to no DOM mutation. Only the React commit meter sees the storm.
 */
function installRenderStorm(): void {
  setInterval(() => {
    useApp.setState((s) => ({ series: [...s.series] }));
  }, 16);
}

/** Inject a transparent overlay covering the target so pointer hits land on the overlay, not it. */
function installOcclusion(testid: string): void {
  const overlayId = `reticle-hard-bug-overlay-${testid}`;
  const apply = (): void => {
    const target = document.querySelector(sel(testid));
    if (target === null || document.getElementById(overlayId) !== null) return;
    const rect = target.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:99999;background:transparent;`;
    document.body.appendChild(overlay);
  };
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
  apply();
}

/**
 * One capture-phase click listener drives every action-triggered bug (tamper / console leak / extra
 * fetch). Capture phase fires before React's root-delegated handler, so a synchronous tamper is present
 * the moment the action runs; a deferred tamper is scheduled to land right after. Fire-and-forget:
 * errors are swallowed so a bug never breaks the app. No-op when nothing is active.
 */
function installClickBugs(bugs: ReadonlySet<string>): void {
  const tampers = [...bugs].map((id) => TAMPER[id]).filter((t): t is Tamper => t !== undefined);
  const leaks = [...bugs].map((id) => CONSOLE_LEAKS[id]).filter((t): t is string => t !== undefined);
  const fetches = [...bugs]
    .map((id) => EXTRA_FETCH[id])
    .filter((f): f is ExtraFetch => f !== undefined);
  if (tampers.length === 0 && leaks.length === 0 && fetches.length === 0) return;
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const hit = (t: string): boolean => target.closest(sel(t)) !== null;
      for (const t of tampers) {
        if (!hit(t.trigger)) continue;
        if (t.defer) setTimeout(t.run, 0);
        else t.run();
      }
      for (const trigger of leaks) {
        if (hit(trigger)) setTimeout(() => console.error(CONSOLE_MSG), 0);
      }
      for (const f of fetches) {
        if (!hit(f.trigger)) continue;
        const init: RequestInit = f.method === 'POST' ? { method: 'POST', body: '{}' } : { method: 'GET' };
        void window.fetch(f.url, init).catch(() => undefined);
      }
    },
    true,
  );
}

/** Silently overwrite a labelled element's text with a wrong value; re-applied so React can't restore. */
function installDomTextBugs(bugs: ReadonlySet<string>): void {
  const active = [...bugs]
    .map((id) => DOM_TEXT[id])
    .filter((b): b is { testid: string; wrong: string } => b !== undefined);
  if (active.length === 0) return;
  const apply = (): void => {
    for (const b of active) {
      const el = document.querySelector(sel(b.testid));
      if (el !== null && el.textContent !== b.wrong) el.textContent = b.wrong;
    }
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
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
 * Install the hard-bug injector. No-op unless `?reticle-bug=` is present. Each id degrades a present,
 * correctly-labelled element (or the store behind it) so only observation of style/geometry, the
 * network, the console, or the app's state can catch it.
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
  for (const [id, testid] of Object.entries(OCCLUDE)) {
    if (bugs.has(id)) installOcclusion(testid);
  }
  if (bugs.has('state-desync')) installStateDesync();
  if (bugs.has('status-stale')) installStatusDesync();
  if (bugs.has('render-storm')) installRenderStorm();
  installClickBugs(bugs);
  installDomTextBugs(bugs);
}
