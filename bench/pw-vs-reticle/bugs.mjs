// Central bug registry for the Playwright-vs-Reticle benchmark.
//
// Each bug is injected into apps/bench-app via ?reticle-bug=<id> (see reticle-bug-injector.ts), or,
// for the two regression bugs, via a ?reticle-break-click= URL supplied in the entry's `url` field
// (see reticle-regress.ts). Every bug carries ONE intent-level check that a harness must verify. A
// harness "detects" the bug when its check correctly FAILS on the buggy build (and must NOT fail on the
// clean build — that would be a false positive). The `expect` field is the ground-truth capability
// line: which harness class CAN catch it, so the scorecard separates "missed" from "not-expected".
//
// `expect` is fixed by the check KIND, because each harness only implements the kinds it structurally
// can (the other harness's branch returns caught=false):
//   both          — usable, consoleCleanAfter, netCountAfter, domText  (DOM / console / network)
//   reticle-only  — domCountMatchesState, stateInvariantAfter, stateEqualsAfter  (needs app state)
//   playwright-only — paint  (needs pixels)
//
// Check kinds (interpreted by each harness in its own capability):
//   usable              — element {testid} must be visible, non-zero, un-occluded.
//   paint               — full-page pixels must match the clean baseline (screenshot territory).
//   domText             — element {testid}'s text must still contain {expected} (a display/mock-data lie).
//   domCountMatchesState— DOM badge {testid} number must equal store path {statePath} length.
//   consoleCleanAfter   — after clicking {steps}, no console.error in the window.
//   netCountAfter       — after clicking {steps}, exactly {expected} requests match {urlContains}+{method}.
//   stateInvariantAfter — after clicking {steps}, store path {statePath} is UNCHANGED (blast radius).
//   stateEqualsAfter    — after clicking {steps}, store path {statePath} must EQUAL {expected} (invariant).
//
// `setup` = testids to click (in order) to reach the screen before checking. Login is pre-filled, so
// clicking `login-submit` authenticates. `prep` (inside check) fills one input before the action.
// `url` (optional) overrides the buggy-variant URL (used by the two ?reticle-break-click regressions).

export const APP_ORIGIN = 'http://localhost:4312';

/** Build the fixture URL for a bug id (empty id = clean build). */
export function bugUrl(id) {
  return id ? `${APP_ORIGIN}/?reticle-bug=${encodeURIComponent(id)}` : `${APP_ORIGIN}/`;
}

/**
 * Storage survives navigation within an origin, so one bug's writes leak into the next bug's run —
 * the buggy `logout-leaves-token` deliberately leaves a token behind, which then made a later storage
 * check pass for the wrong reason. Storage bugs load with an explicit reset so each run starts clean.
 */
export function storageBugUrl(id) {
  const base = bugUrl(id);
  return `${base}${base.includes('?') ? '&' : '?'}reticle-reset-storage=1`;
}

const composePrep = { fill: 'compose-prompt', text: 'benchmark note' };
const namePrep = { fill: 'deploy-name', text: 'benchmark-svc' };

/** Mirrors apps/bench-app/src/lib/persisted-session.ts — the bench is JS and cannot import the TS module. */
const AUTH_TOKEN_KEY = 'reticle.bench.authToken';
const SESSION_ID_KEY = 'reticle.bench.sessionId';
const SESSION_COOKIE = 'bench_session';

/**
 * Severity is graded by CONSEQUENCE TO THE USER, deliberately NOT by how hard the bug is to detect.
 * A cosmetic regression that no tool can see is still cosmetic; a silently-wrong total written to disk
 * is critical even when a one-line assertion would catch it. Grading by difficulty would let the suite
 * flatter whichever tool happens to be good at the hard-but-unimportant cases.
 *
 *   critical — wrong data persisted, auth/money affected, or the UI reports success over a failure
 *   high     — functionally broken for a real task, or a signal downstream code depends on is wrong
 *   medium   — a control is unusable, or content is missing/wrong, without corrupting data
 *   low      — visual or performance degradation a user notices but can work around
 *   none     — traps: not bugs. They exist to catch a harness that over-flags a healthy build.
 */
export const SEVERITY_BY_CATEGORY = {
  'business-logic': 'critical',
  storage: 'critical',
  'net-status': 'critical',
  'net-hang': 'critical',
  state: 'critical',
  // Server state served stale is a data-correctness failure: the user acts on a number the server
  // has already moved past, and nothing on screen or on the wire says so.
  'server-state': 'critical',
  signal: 'high',
  streams: 'high',
  network: 'high',
  console: 'high',
  'mock-data': 'high',
  routing: 'high',
  regression: 'high',
  'ui-visual': 'medium',
  'deep-dom': 'medium',
  'silent-removal': 'medium',
  timing: 'medium',
  'ui-paint': 'low',
  perf: 'low',
  chart: 'high',
  'false-positive-trap': 'none',
};

/** Severity for a bug, derived from its category so a new bug cannot silently arrive ungraded. */
export function severityOf(bug) {
  const sev = SEVERITY_BY_CATEGORY[bug.category];
  if (sev === undefined)
    throw new Error(`bugs.mjs: category "${bug.category}" has no severity grade`);
  return sev;
}

export const BUGS = [
  // ── ui-visual (usable): the control is present + labelled, but not actually usable ──────────────
  {
    id: 'invisible',
    category: 'ui-visual',
    intent: 'the "New deploy" button is usable (a real user can see and click it)',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'usable', testid: 'new-deploy' },
    expect: 'both',
  },
  {
    id: 'zero-size',
    category: 'ui-visual',
    intent: 'the "New deploy" button has real size (not collapsed to 0×0)',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'usable', testid: 'new-deploy' },
    expect: 'both',
  },
  {
    id: 'occluded',
    category: 'ui-visual',
    intent: 'the "New deploy" button is usable (nothing covers it)',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'usable', testid: 'new-deploy' },
    expect: 'both',
  },
  {
    id: 'nav-deployments-occluded',
    category: 'ui-visual',
    intent: 'the Deployments nav item is usable (no transparent overlay)',
    setup: ['login-submit'],
    check: { kind: 'usable', testid: 'nav-deployments' },
    expect: 'both',
  },
  {
    id: 'cmdk-occluded',
    category: 'ui-visual',
    intent: 'the command-palette opener is usable (nothing covers it)',
    setup: ['login-submit'],
    check: { kind: 'usable', testid: 'cmdk-open' },
    expect: 'both',
  },
  {
    id: 'nav-compose-invisible',
    category: 'ui-visual',
    intent: 'the Compose nav item is visible',
    setup: ['login-submit'],
    check: { kind: 'usable', testid: 'nav-compose' },
    expect: 'both',
  },
  {
    id: 'nav-overview-invisible',
    category: 'ui-visual',
    intent: 'the Overview nav item is visible',
    setup: ['login-submit'],
    check: { kind: 'usable', testid: 'nav-overview' },
    expect: 'both',
  },
  {
    id: 'nav-deployments-invisible',
    category: 'ui-visual',
    intent: 'the Deployments nav item is visible',
    setup: ['login-submit'],
    check: { kind: 'usable', testid: 'nav-deployments' },
    expect: 'both',
  },
  {
    id: 'nav-overview-collapsed',
    category: 'ui-visual',
    intent: 'the Overview nav item has real size (not collapsed to 0×0)',
    setup: ['login-submit'],
    check: { kind: 'usable', testid: 'nav-overview' },
    expect: 'both',
  },
  {
    id: 'nav-diagnostics-collapsed',
    category: 'ui-visual',
    intent: 'the Diagnostics nav item has real size (not collapsed to 0×0)',
    setup: ['login-submit'],
    check: { kind: 'usable', testid: 'nav-diagnostics' },
    expect: 'both',
  },
  {
    id: 'cmdk-invisible',
    category: 'ui-visual',
    intent: 'the command-palette opener is visible',
    setup: ['login-submit'],
    check: { kind: 'usable', testid: 'cmdk-open' },
    expect: 'both',
  },
  {
    id: 'cmdk-collapsed',
    category: 'ui-visual',
    intent: 'the command-palette opener has real size (not collapsed to 0×0)',
    setup: ['login-submit'],
    check: { kind: 'usable', testid: 'cmdk-open' },
    expect: 'both',
  },
  {
    id: 'env-filter-invisible',
    category: 'ui-visual',
    intent: 'the environment filter button is visible',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'usable', testid: 'env-filter' },
    expect: 'both',
  },
  {
    id: 'env-filter-collapsed',
    category: 'ui-visual',
    intent: 'the environment filter button has real size (not collapsed to 0×0)',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'usable', testid: 'env-filter' },
    expect: 'both',
  },
  {
    id: 'login-invisible',
    category: 'ui-visual',
    intent: 'the sign-in button is visible on the login screen',
    setup: [],
    check: { kind: 'usable', testid: 'login-submit' },
    expect: 'both',
  },
  {
    id: 'login-collapsed',
    category: 'ui-visual',
    intent: 'the sign-in button has real size (not collapsed to 0×0)',
    setup: [],
    check: { kind: 'usable', testid: 'login-submit' },
    expect: 'both',
  },

  // ── ui-paint (paint): computed styles unchanged, only painted pixels differ ─────────────────────
  {
    id: 'paint-filter',
    category: 'ui-paint',
    intent: 'the page renders with the correct colors (no global hue-rotate paint regression)',
    setup: ['login-submit'],
    check: { kind: 'paint' },
    // Was 'playwright-only' on the reasoning that a paint regression "needs pixels" and Reticle reads
    // the program. That was wrong: reticle_screenshot + reticle_visual_diff exist, and once the
    // harness drove a real browser instead of only attaching, both tools caught it (2.12% of pixels
    // changed against a 1% tolerance). The label described the harness, not the capability.
    expect: 'both',
  },
  {
    id: 'paint-invert',
    category: 'ui-paint',
    intent: 'the page renders with the correct colors (no global invert paint regression)',
    setup: ['login-submit'],
    check: { kind: 'paint' },
    expect: 'both', // see paint-filter: the old 'playwright-only' described the harness, not the tool
  },

  // ── state (needs the store as source of truth): the DOM looks fine, the store proves it wrong ───
  {
    // Reclassified reticle-only → both: the store's true count is ALSO rendered as the "N of N" toolbar
    // text on the Deployments view, so a thorough cross-navigating DOM agent can catch the lie by
    // comparing the nav badge to that number — no store access required. The reticle-script catches it
    // via the store; the playwright-script (which reads only the badge) does not, but the capability
    // line is honestly "both".
    id: 'state-desync',
    category: 'state',
    intent:
      'the Deployments nav badge count agrees with the store (also shown as the toolbar "N of N")',
    setup: ['login-submit'],
    check: { kind: 'domCountMatchesState', testid: 'nav-deployments', statePath: 'deployments' },
    expect: 'both',
  },
  {
    id: 'mutation-leak',
    category: 'state',
    intent:
      "generating a script does not corrupt the top deployment's internal build checksum (never rendered)",
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'stateInvariantAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      statePath: 'deployments.0.checksum',
    },
    expect: 'reticle-only',
  },
  {
    id: 'generate-blast-filter',
    category: 'state',
    intent:
      "generating a script does not overwrite the top deployment's internal cost figure (never rendered)",
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'stateInvariantAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      statePath: 'deployments.0.costUsd',
    },
    expect: 'reticle-only',
  },
  {
    id: 'generate-blast-selected',
    category: 'state',
    intent: 'generating a script does not mutate the selected-deployment id',
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'stateInvariantAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      statePath: 'selectedId',
    },
    expect: 'reticle-only',
  },
  {
    id: 'generate-blast-drawer',
    category: 'state',
    intent: 'generating a script does not open the (off-screen) deployment drawer in state',
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'stateInvariantAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      statePath: 'drawerId',
    },
    expect: 'reticle-only',
  },
  {
    id: 'nav-blast-prompt',
    category: 'state',
    intent:
      "navigating to Diagnostics does not corrupt the top deployment's internal checksum (never rendered)",
    setup: ['login-submit'],
    check: {
      kind: 'stateInvariantAfter',
      steps: ['nav-diagnostics'],
      statePath: 'deployments.0.checksum',
    },
    expect: 'reticle-only',
  },
  {
    id: 'nav-blast-title',
    category: 'state',
    intent:
      "navigating to Diagnostics does not corrupt the top deployment's internal cost figure (never rendered)",
    setup: ['login-submit'],
    check: {
      kind: 'stateInvariantAfter',
      steps: ['nav-diagnostics'],
      statePath: 'deployments.0.costUsd',
    },
    expect: 'reticle-only',
  },
  {
    id: 'newdeploy-blast-kpi',
    category: 'state',
    intent:
      "opening the new-deploy modal does not corrupt the top deployment's internal cost figure (never rendered)",
    setup: ['login-submit', 'nav-deployments'],
    check: {
      kind: 'stateInvariantAfter',
      steps: ['new-deploy'],
      statePath: 'deployments.0.costUsd',
    },
    expect: 'reticle-only',
  },

  // ── console (a clean-console oracle): the UI renders fine, but an error is logged ────────────────
  {
    id: 'console-leak',
    category: 'console',
    intent: 'generating a script does not emit a console error',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'consoleCleanAfter', prep: composePrep, steps: ['compose-generate'] },
    expect: 'both',
  },
  {
    id: 'console-leak-newdeploy',
    category: 'console',
    intent: 'opening the new-deploy modal does not emit a console error',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'consoleCleanAfter', steps: ['new-deploy'] },
    expect: 'both',
  },
  {
    id: 'console-leak-diagnostics',
    category: 'console',
    intent: 'navigating to Diagnostics does not emit a console error',
    setup: ['login-submit'],
    check: { kind: 'consoleCleanAfter', steps: ['nav-diagnostics'] },
    expect: 'both',
  },
  {
    id: 'console-leak-cmdk',
    category: 'console',
    intent: 'opening the command palette does not emit a console error',
    setup: ['login-submit'],
    check: { kind: 'consoleCleanAfter', steps: ['cmdk-open'] },
    expect: 'both',
  },
  {
    id: 'console-leak-env',
    category: 'console',
    intent: 'opening the environment filter does not emit a console error',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'consoleCleanAfter', steps: ['env-filter'] },
    expect: 'both',
  },
  {
    id: 'console-leak-login',
    category: 'console',
    intent: 'signing in does not emit a console error',
    setup: [],
    check: { kind: 'consoleCleanAfter', steps: ['login-submit'] },
    expect: 'both',
  },

  // ── network (a request-count oracle): the right endpoint, the wrong number of times ─────────────
  {
    id: 'double-submit',
    category: 'network',
    intent: 'generating a script fires exactly one POST /api/generate-script',
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'netCountAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      urlContains: '/api/generate-script',
      method: 'POST',
      expected: 1,
    },
    expect: 'both',
  },
  {
    id: 'forbidden-call',
    category: 'network',
    intent: 'generating a script never calls the forbidden /api/legacy-telemetry endpoint',
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'netCountAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      urlContains: '/api/legacy-telemetry',
      method: 'POST',
      expected: 0,
    },
    expect: 'both',
  },
  {
    id: 'compose-cors-leak',
    category: 'network',
    intent: 'generating a script never hits the forbidden cross-origin /api/broken/cors endpoint',
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'netCountAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      urlContains: '/api/broken/cors',
      method: 'GET',
      expected: 0,
    },
    expect: 'both',
  },
  {
    id: 'forbidden-500-newdeploy',
    category: 'network',
    intent: 'opening the new-deploy modal never fires a stray GET /api/broken/500',
    setup: ['login-submit', 'nav-deployments'],
    check: {
      kind: 'netCountAfter',
      steps: ['new-deploy'],
      urlContains: '/api/broken/500',
      method: 'GET',
      expected: 0,
    },
    expect: 'both',
  },
  {
    id: 'login-beacon',
    category: 'network',
    intent: 'signing in never fires the forbidden /api/legacy-telemetry privacy beacon',
    setup: [],
    check: {
      kind: 'netCountAfter',
      steps: ['login-submit'],
      urlContains: '/api/legacy-telemetry',
      method: 'POST',
      expected: 0,
    },
    expect: 'both',
  },
  {
    id: 'double-login',
    category: 'network',
    intent: 'signing in fires exactly one POST /api/login',
    setup: [],
    check: {
      kind: 'netCountAfter',
      steps: ['login-submit'],
      urlContains: '/api/login',
      method: 'POST',
      expected: 1,
    },
    expect: 'both',
  },
  {
    id: 'nav-beacon',
    category: 'network',
    intent: 'navigating to Overview never fires the forbidden /api/legacy-telemetry beacon',
    setup: ['login-submit'],
    check: {
      kind: 'netCountAfter',
      steps: ['nav-overview'],
      urlContains: '/api/legacy-telemetry',
      method: 'POST',
      expected: 0,
    },
    expect: 'both',
  },
  {
    id: 'double-fault-500',
    category: 'network',
    intent: 'the 500 fault button fires exactly one GET /api/broken/500',
    setup: ['login-submit', 'nav-diagnostics'],
    check: {
      kind: 'netCountAfter',
      steps: ['fault-500'],
      urlContains: '/api/broken/500',
      method: 'GET',
      expected: 1,
    },
    expect: 'both',
  },

  // ── mock-data (a display oracle): a rendered label/number is silently wrong ──────────────────────
  {
    id: 'brand-typo',
    category: 'mock-data',
    intent: 'the sidebar brand name still reads "Reticle"',
    setup: ['login-submit'],
    check: { kind: 'domText', testid: 'brand', expected: 'Reticle' },
    expect: 'both',
  },
  {
    id: 'session-pill-typo',
    category: 'mock-data',
    intent: 'the session pill still reports the agent as "connected"',
    setup: ['login-submit'],
    check: { kind: 'domText', testid: 'session-pill', expected: 'connected' },
    expect: 'both',
  },
  {
    id: 'console-count-lie',
    category: 'mock-data',
    intent: 'the Diagnostics error counter reads "0 err" before any fault is triggered',
    setup: ['login-submit', 'nav-diagnostics'],
    check: { kind: 'domText', testid: 'console-count', expected: '0 err' },
    expect: 'both',
  },
  {
    id: 'nav-label-typo',
    category: 'mock-data',
    intent: 'the Compose nav item is still labelled "Compose"',
    setup: ['login-submit'],
    check: { kind: 'domText', testid: 'nav-compose', expected: 'Compose' },
    expect: 'both',
  },

  // ── business-logic (a store-invariant oracle): the action produced a wrong value, hidden off-screen ─
  {
    id: 'kpi-deploys-tamper',
    category: 'business-logic',
    intent:
      "an unrelated Compose action must not corrupt the top deployment's internal cost (1200)",
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'stateEqualsAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      statePath: 'deployments.0.costUsd',
      expected: 1200,
    },
    expect: 'reticle-only',
  },
  {
    id: 'kpi-success-tamper',
    category: 'business-logic',
    intent:
      'an unrelated Compose action must not corrupt the top deployment\'s internal checksum ("9a3f00")',
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'stateEqualsAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      statePath: 'deployments.0.checksum',
      expected: '9a3f00',
    },
    expect: 'reticle-only',
  },
  {
    id: 'kpi-p95-tamper',
    category: 'business-logic',
    intent:
      "an unrelated Compose action must not corrupt the second deployment's internal cost (1215)",
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'stateEqualsAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      statePath: 'deployments.1.costUsd',
      expected: 1215,
    },
    expect: 'reticle-only',
  },
  {
    id: 'kpi-services-tamper',
    category: 'business-logic',
    intent:
      'an unrelated Compose action must not corrupt the second deployment\'s internal checksum ("9a3f01")',
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'stateEqualsAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      statePath: 'deployments.1.checksum',
      expected: '9a3f01',
    },
    expect: 'reticle-only',
  },
  {
    id: 'create-wrong-author',
    category: 'business-logic',
    intent:
      'a created deployment records the correct internal checksum ("2328"), not a corrupted one',
    setup: ['login-submit', 'nav-deployments', 'new-deploy'],
    check: {
      kind: 'stateEqualsAfter',
      prep: namePrep,
      steps: ['deploy-submit'],
      statePath: 'deployments.0.checksum',
      expected: '2328',
    },
    expect: 'reticle-only',
  },
  {
    id: 'create-wrong-createdat',
    category: 'business-logic',
    intent:
      'a created deployment records the correct internal cost (0, not yet costed), not a bogus figure',
    setup: ['login-submit', 'nav-deployments', 'new-deploy'],
    check: {
      kind: 'stateEqualsAfter',
      prep: namePrep,
      steps: ['deploy-submit'],
      statePath: 'deployments.0.costUsd',
      expected: 0,
    },
    expect: 'reticle-only',
  },

  // ── regression (?reticle-break-click): the control resolves green, but its handler is dead ───────
  {
    id: 'regress-deadclick-generate',
    category: 'regression',
    intent: 'clicking Generate actually fires the POST /api/generate-script (handler not dead)',
    url: `${APP_ORIGIN}/?reticle-break-click=compose-generate`,
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'netCountAfter',
      prep: composePrep,
      steps: ['compose-generate'],
      urlContains: '/api/generate-script',
      method: 'POST',
      expected: 1,
    },
    expect: 'both',
  },
  {
    id: 'regress-deadclick-login',
    category: 'regression',
    intent: 'clicking Sign in actually fires the POST /api/login (handler not dead)',
    url: `${APP_ORIGIN}/?reticle-break-click=login-submit`,
    setup: [],
    check: {
      kind: 'netCountAfter',
      steps: ['login-submit'],
      urlContains: '/api/login',
      method: 'POST',
      expected: 1,
    },
    expect: 'both',
  },

  // ── net-status: the hidden-500 class (net-status) — the request FAILS, the UI shows success anyway. ────
  // The DOM and a screenshot are both correct here; only the wire disagrees. This is the flagship
  // "structurally invisible" case for a screenshot/DOM tool.
  {
    id: 'swallowed-500-generate',
    category: 'net-status',
    intent: 'the generate request actually succeeded (not a 500 the UI swallowed)',
    setup: ['login-submit', 'nav-compose', composePrep],
    check: {
      kind: 'netStatusAfter',
      steps: ['compose-generate'],
      urlContains: '/api/generate-script',
      expected: 200,
    },
    // reticle-only, MEASURED: the fault is client-side, so the wire still shows 200 and a
    // request/response observer sees nothing wrong. Only an in-page view sees what the app got.
    expect: 'reticle-only',
  },
  {
    id: 'swallowed-500-login',
    category: 'net-status',
    intent: 'login actually succeeded (not a 500 the UI proceeded past)',
    setup: [],
    check: {
      kind: 'netStatusAfter',
      steps: ['login-submit'],
      urlContains: '/api/login',
      expected: 200,
    },
    expect: 'both',
  },
  {
    id: 'wrong-content-type',
    category: 'net-status',
    intent: 'the generate endpoint answers JSON (not an HTML error page with a 200)',
    setup: ['login-submit', 'nav-compose', composePrep],
    check: {
      kind: 'netStatusAfter',
      steps: ['compose-generate'],
      urlContains: '/api/generate-script',
      expected: 200,
      contentType: 'application/json',
    },
    expect: 'reticle-only',
  },
  {
    id: 'payload-missing-field',
    category: 'net-status',
    intent: 'the generate request actually sends the prompt (server must not silently default it)',
    setup: ['login-submit', 'nav-compose', composePrep],
    check: {
      kind: 'netBodyAfter',
      steps: ['compose-generate'],
      urlContains: '/api/generate-script',
      direction: 'request',
      expected: 'prompt',
    },
    // MEASURED 'both': Playwright reads the outgoing body via request.postData() — clean contains
    // 'prompt', buggy does not. Was reticle-only only because the check was never written.
    expect: 'both',
  },

  // ── net-hang: the in-flight oracle (net-payload) — the request never resolves. ───────────────────────────
  {
    id: 'hung-generate',
    category: 'net-hang',
    intent: 'the generate request completes (no forever-spinner)',
    setup: ['login-submit', 'nav-compose', composePrep],
    check: {
      kind: 'netPendingAfter',
      steps: ['compose-generate'],
      urlContains: '/api/generate-script',
      withinMs: 3000,
    },
    // CLASSIFICATION PENDING RE-MEASUREMENT. This said "reticle-only, MEASURED: Playwright sees
    // requests=0", which described the harness BEFORE its oracle was completed. Playwright now scores
    // `pending > 0 || completed2xx === 0`, and a hang that sends nothing satisfies the second disjunct
    // — so it may well discriminate. The label stays until a live run says otherwise; changing a
    // ground-truth classification on reasoning alone is the mistake that produced the wrong value.
    expect: 'reticle-only',
  },
  {
    id: 'slow-then-drop',
    category: 'net-hang',
    intent: 'the generate request lands a completed 2xx (not aborted mid-flight and swallowed)',
    setup: ['login-submit', 'nav-compose', composePrep],
    check: {
      kind: 'netStatusAfter',
      steps: ['compose-generate'],
      urlContains: '/api/generate-script',
      expected: 200,
    },
    expect: 'reticle-only',
  },

  // ── silent-removal: a NON-INTERACTIVE element vanishes. Nothing errors, no click breaks, so a
  // crawler that only exercises controls is structurally blind. Only a saved baseline notices. ───────
  {
    id: 'token-not-persisted',
    category: 'storage',
    intent: 'signing in writes an auth token that survives a reload',
    setup: ['login-submit'],
    check: { kind: 'storagePresentAfter', area: 'local', key: AUTH_TOKEN_KEY, expectPresent: true },
    expect: 'both',
  },
  {
    id: 'logout-leaves-token',
    category: 'storage',
    intent: 'signing out actually clears the auth token, not just the UI',
    setup: ['login-submit'],
    check: {
      kind: 'storagePresentAfter',
      steps: ['sign-out'],
      area: 'local',
      key: AUTH_TOKEN_KEY,
      expectPresent: false,
    },
    expect: 'both',
  },
  {
    id: 'session-in-localstorage',
    category: 'storage',
    intent: 'the session id is session-scoped — it must NOT outlive the tab in localStorage',
    setup: ['login-submit'],
    check: {
      kind: 'storagePresentAfter',
      area: 'local',
      key: SESSION_ID_KEY,
      expectPresent: false,
    },
    expect: 'both',
  },
  {
    id: 'stale-cache-key',
    category: 'storage',
    intent: 'the token is written under the current key, not the pre-rename one',
    setup: ['login-submit'],
    check: { kind: 'storagePresentAfter', area: 'local', key: AUTH_TOKEN_KEY, expectPresent: true },
    expect: 'both',
  },
  {
    id: 'cookie-not-set',
    category: 'storage',
    intent: 'the sign-in session cookie reaches the browser, so the server sees the session too',
    setup: ['login-submit'],
    check: {
      kind: 'storagePresentAfter',
      area: 'cookies',
      key: SESSION_COOKIE,
      expectPresent: true,
    },
    expect: 'both',
  },
  {
    id: 'debounce-broken',
    category: 'timing',
    intent: 'a burst of keystrokes issues ONE search request, not one per keystroke',
    setup: ['login-submit', 'nav-diagnostics'],
    check: {
      kind: 'netCountAfterBurst',
      testid: 'timing-search',
      values: ['a', 'ap', 'api', 'api-', 'api-g'],
      urlContains: '/api/search',
      gapMs: 60,
      // Must exceed the fixture's debounce window so the single coalesced request has landed.
      settleMs: 3000,
      maxExpected: 2,
    },
    expect: 'both',
  },
  {
    id: 'retry-storm',
    category: 'timing',
    intent: 'a failing request is retried a bounded number of times, then gives up',
    setup: ['login-submit', 'nav-diagnostics'],
    check: {
      kind: 'netCountCapped',
      steps: ['timing-retry'],
      urlContains: '/api/flaky',
      settleMs: 3500,
      maxExpected: 4,
    },
    expect: 'both',
  },
  {
    id: 'trap-timestamp-region',
    category: 'false-positive-trap',
    trap: true,
    // Not a bug. The timestamp beside the label rewrites itself several times a second on a HEALTHY
    // build. A text or diff oracle that reads "it changed" as "it broke" would flag this forever.
    intent: 'a live-updating timestamp must not make a stable neighbour read as changed',
    setup: ['login-submit', 'nav-diagnostics'],
    check: {
      kind: 'stableTextDespiteChurn',
      churnTestid: 'timing-clock',
      stableTestid: 'timing-clock-label',
      expectStable: 'Last refreshed',
      waitMs: 1200,
    },
    expect: 'none',
  },
  {
    id: 'sse-silent-stop',
    category: 'streams',
    intent: 'the build-log stream actually delivers frames, not just an open connection',
    setup: ['login-submit', 'nav-diagnostics'],
    check: { kind: 'streamFramesAfter', urlContains: '/api/build-log', minFrames: 1, waitMs: 3000 },
    // reticle-only: an SSE body is a streaming response — the script harness sees the request but
    // never the individual frames.
    expect: 'reticle-only',
  },
  {
    id: 'sse-malformed-frame',
    category: 'streams',
    intent: 'every frame the stream delivers is actually rendered — none silently dropped',
    setup: ['login-submit', 'nav-diagnostics'],
    check: {
      kind: 'streamVsDomCount',
      urlContains: '/api/build-log',
      testid: 'stream-steps',
      waitMs: 3000,
    },
    expect: 'reticle-only',
  },
  {
    id: 'ws-wrong-payload',
    category: 'streams',
    intent: 'the echo replies on the channel the client subscribed to',
    setup: ['login-submit', 'nav-diagnostics'],
    check: {
      kind: 'streamPayloadAfter',
      steps: ['ws-send'],
      expectContains: 'deployments',
      waitMs: 1500,
    },
    // Playwright exposes WebSocket frames via page.on('websocket'), so this is a fair 'both'.
    expect: 'both',
  },
  {
    id: 'shadow-label-typo',
    category: 'deep-dom',
    intent: 'the status label inside the shadow root reads correctly',
    setup: ['login-submit', 'nav-diagnostics'],
    check: {
      kind: 'domTextDeep',
      scope: '[data-testid="shadow-host"]',
      deepTestid: 'shadow-status',
      expectText: 'All systems nominal',
    },
    expect: 'both',
  },
  {
    id: 'stale-cache-serves-old',
    category: 'server-state',
    intent: 'adding an item leaves the UI showing what the server actually holds',
    setup: ['login-submit', 'nav-diagnostics'],
    check: {
      kind: 'staleCacheAfterMutation',
      testid: 'query-add-item',
      store: 'queries',
      key: 'items',
    },
    // 'both', and the label is doing real work. The mutation succeeds and then NOTHING refetches, so
    // Playwright can catch it by request cardinality (a POST with no follow-up GET). Reticle catches
    // it by reading the cache directly — the total is unchanged while `isStale` is still false, i.e.
    // the cache is CONFIDENTLY serving a value the server has moved past.
    //
    // The reason to keep it here is not exclusivity, it is that this is the archetypal server-state
    // failure: the screen is plausible, the network is SILENT, and the only witness to the disagreement
    // is freshness metadata that lives in neither the DOM nor the request log.
    expect: 'both',
  },
  {
    id: 'chart-empty-series',
    category: 'chart',
    intent: 'the overview chart plots the series it was given',
    setup: ['login-submit'],
    check: { kind: 'chartGeometryFault', testid: 'area-chart' },
    // 'both' on purpose. SVG geometry IS in the DOM, so a Playwright script can read `points` and
    // spot NaN exactly as we do — labelling this reticle-only would be inventing a moat. The real
    // difference is that Reticle reports the fault on the descriptor WITHOUT being asked, while the
    // Playwright check only finds it because this harness was told where to look.
    expect: 'both',
  },
  {
    id: 'chart-single-point',
    category: 'chart',
    intent: 'the overview chart plots the series it was given',
    setup: ['login-submit'],
    check: { kind: 'chartGeometryFault', testid: 'area-chart' },
    expect: 'both',
  },
  {
    id: 'shadow-control-dead',
    category: 'deep-dom',
    intent: 'the refresh control inside the shadow root still makes its request',
    setup: ['login-submit', 'nav-diagnostics'],
    check: {
      kind: 'deepNetCountAfter',
      deepTestid: 'shadow-refresh',
      urlContains: '/api/health',
    },
    // 'both', re-measured live: reticle clean +1 request / buggy +0, matching Playwright exactly.
    // Was briefly recorded as playwright-only on a wrong diagnosis — the check passed `selector:` to
    // reticle_act, an input that does not exist, so the click was a no-op and BOTH variants showed
    // zero requests. reticle_act reaches shadow controls fine once query can hand it a ref.
    expect: 'both',
  },
  {
    id: 'iframe-stale-data',
    category: 'deep-dom',
    intent: 'the iframe panel shows the CURRENT deployment count, not a frozen one',
    setup: ['login-submit', 'nav-diagnostics'],
    check: {
      kind: 'deepCountMatchesState',
      scope: '[data-testid="deep-iframe"]',
      statePath: 'deployments',
    },
    expect: 'reticle-only',
  },
  {
    id: 'toast-never-dismisses',
    category: 'timing',
    intent: 'the success toast honours its own 4.2s auto-dismiss',
    setup: ['login-submit', 'nav-deployments', 'new-deploy'],
    check: {
      kind: 'domAbsentAfterDelay',
      prep: { fill: 'deploy-name', text: 'benchmark-svc' },
      steps: ['deploy-submit'],
      testid: 'toast',
      // createDeployment pushes TWO toasts: one immediately, one at 2600ms when the deploy goes live.
      // The later one lives until 2600+4200=6800ms, so anything under that finds a toast on screen for
      // entirely correct reasons — a 6000ms window read as "never dismisses" on a CLEAN build.
      delayMs: 8200,
    },
    expect: 'both',
  },
  {
    id: 'trap-ambient-animation',
    category: 'false-positive-trap',
    trap: true,
    // Not a bug. The page carries infinite ambient animations (livePulse, reticlePulse) on a HEALTHY
    // build. A settle oracle that reads "something is still moving" as "not settled" would hang and
    // report trouble where there is none. Detection here is the failure, which is why it scores as a
    // false positive rather than a catch.
    intent: 'an infinite ambient animation must not stop the page from settling',
    setup: ['login-submit'],
    check: { kind: 'settlesDespiteAnimation', quietMs: 500, timeoutMs: 8000 },
    expect: 'none',
  },
  {
    id: 'signal-missing-generate',
    category: 'signal',
    intent: 'generating a script announces compose:generated exactly once',
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'signalFiredAfter',
      prep: { fill: 'compose-prompt', text: 'benchmark note' },
      steps: ['compose-generate'],
      signal: 'compose:generated',
      expected: 1,
    },
    expect: 'reticle-only',
  },
  {
    id: 'signal-missing-deploy',
    category: 'signal',
    intent: 'creating a deployment announces deploy:created exactly once',
    setup: ['login-submit', 'nav-deployments', 'new-deploy'],
    check: {
      kind: 'signalFiredAfter',
      prep: { fill: 'deploy-name', text: 'bench-svc' },
      steps: ['deploy-submit'],
      signal: 'deploy:created',
      expected: 1,
    },
    expect: 'reticle-only',
  },
  {
    id: 'signal-double-fire',
    category: 'signal',
    intent: 'one generate click announces compose:generated once, not twice',
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'signalFiredAfter',
      prep: { fill: 'compose-prompt', text: 'benchmark note' },
      steps: ['compose-generate'],
      signal: 'compose:generated',
      expected: 1,
    },
    expect: 'reticle-only',
  },
  {
    id: 'signal-wrong-name',
    category: 'signal',
    intent: 'the generate signal uses its declared name, not a typo',
    setup: ['login-submit', 'nav-compose'],
    check: {
      kind: 'signalFiredAfter',
      prep: { fill: 'compose-prompt', text: 'benchmark note' },
      steps: ['compose-generate'],
      signal: 'compose:generated',
      expected: 1,
    },
    expect: 'reticle-only',
  },
  {
    id: 'route-stuck-deployments',
    category: 'routing',
    intent: 'opening Deployments actually navigates, so the view is deep-linkable',
    setup: ['login-submit'],
    check: { kind: 'routeAfter', steps: ['nav-deployments'], expectPath: '/deployments' },
    expect: 'both',
  },
  {
    id: 'route-wrong-target',
    category: 'routing',
    intent: 'the Diagnostics nav puts /diagnostics in the URL, not another view',
    setup: ['login-submit'],
    check: { kind: 'routeAfter', steps: ['nav-diagnostics'], expectPath: '/diagnostics' },
    expect: 'both',
  },
  {
    id: 'kpi-card-removed',
    category: 'silent-removal',
    intent: 'the Active-services KPI card is still on the Overview page',
    setup: ['login-submit'],
    check: { kind: 'domPresentVsBaseline', testid: 'kpi-services' },
    expect: 'both',
  },
  {
    id: 'footer-status-removed',
    category: 'silent-removal',
    intent: 'the session status strip is still present',
    setup: ['login-submit'],
    check: { kind: 'domPresentVsBaseline', testid: 'session-pill' },
    expect: 'both',
  },

  // ── perf: the damage is in WHEN the page moved, not what it ends up looking like. A
  // screenshot taken after things settle looks perfect. ─────────────────────────────────────────────
  {
    id: 'cls-late-banner',
    category: 'perf',
    intent: 'the page does not shove content down after it has settled (CLS under 0.1)',
    setup: ['login-submit'],
    check: { kind: 'perfClsUnder', expected: 0.1 },
    // reticle-only, MEASURED not assumed: Playwright observes cls=0.001 clean vs 0.076 buggy — a real
    // 76x separation, but under the 0.1 Web Vitals bar this check asserts, so it does not trip.
    // Honest caveat: a RELATIVE threshold would let Playwright catch this too.
    expect: 'reticle-only',
  },
  {
    id: 'cls-imageless-jump',
    category: 'perf',
    intent: 'the KPI row renders at its final height (no reflow jump)',
    setup: ['login-submit'],
    check: { kind: 'perfClsUnder', expected: 0.1 },
    // reticle-only, but LOW CONFIDENCE: Playwright measures cls=0.001 on the buggy build, i.e. it sees
    // no shift at all. Two tools disagreeing that completely on one page suggests the injection may
    // only move something Reticle measures. Flagged for re-derivation rather than trusted.
    expect: 'reticle-only',
  },
  {
    id: 'longtask-on-nav',
    category: 'perf',
    intent: 'navigating to Diagnostics does not block the main thread',
    setup: ['login-submit'],
    check: { kind: 'perfNoLongTaskAfter', steps: ['nav-diagnostics'], ms: 200 },
    // MEASURED 'both': PerformanceObserver('longtask') in page.evaluate — clean 0, buggy 1. The same
    // browser mechanism Reticle's own SDK uses; the harness simply had not called it.
    expect: 'both',
  },
];

/**
 * Load-time shape guard. A typo'd `expect` value is invisible at runtime — `expectsFor()` simply
 * returns false, so the bug quietly leaves the scoring denominator and the suite reports a healthy
 * ratio over a smaller set. That happened (11 entries said 'reticle' instead of 'reticle-only'), so
 * the shape is now asserted instead of assumed.
 */
const VALID_EXPECT = new Set(['both', 'reticle-only', 'playwright-only']);
/** Traps must NEVER be caught, so they carry no expected catcher — legal only with `trap: true`. */
const TRAP_EXPECT = 'none';
for (const [i, b] of BUGS.entries()) {
  if (!b) throw new Error(`bugs.mjs: hole in the registry at index ${i}`);
  if (b.expect === TRAP_EXPECT) {
    if (b.trap !== true)
      throw new Error(`bugs.mjs: ${b.id} uses expect="${TRAP_EXPECT}" without trap:true`);
  } else if (!VALID_EXPECT.has(b.expect)) {
    throw new Error(
      `bugs.mjs: ${b.id} has expect="${b.expect}", must be one of ${[...VALID_EXPECT].join(' | ')}`,
    );
  }
  if (!b.id || !b.category || !b.check?.kind)
    throw new Error(`bugs.mjs: ${b.id ?? i} is missing id/category/check.kind`);
}
for (const b of BUGS) severityOf(b); // every category must carry a grade
const dupes = BUGS.map((b) => b.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length > 0) throw new Error(`bugs.mjs: duplicate ids: ${dupes.join(', ')}`);
