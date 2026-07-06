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

const composePrep = { fill: 'compose-prompt', text: 'benchmark note' };
const namePrep = { fill: 'deploy-name', text: 'benchmark-svc' };

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
    expect: 'playwright-only',
  },
  {
    id: 'paint-invert',
    category: 'ui-paint',
    intent: 'the page renders with the correct colors (no global invert paint regression)',
    setup: ['login-submit'],
    check: { kind: 'paint' },
    expect: 'playwright-only',
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
    intent: 'the Deployments nav badge count agrees with the store (also shown as the toolbar "N of N")',
    setup: ['login-submit'],
    check: { kind: 'domCountMatchesState', testid: 'nav-deployments', statePath: 'deployments' },
    expect: 'both',
  },
  {
    id: 'mutation-leak',
    category: 'state',
    intent: 'generating a script does not corrupt the top deployment\'s internal build checksum (never rendered)',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'stateInvariantAfter', prep: composePrep, steps: ['compose-generate'], statePath: 'deployments.0.checksum' },
    expect: 'reticle-only',
  },
  {
    id: 'generate-blast-filter',
    category: 'state',
    intent: 'generating a script does not overwrite the top deployment\'s internal cost figure (never rendered)',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'stateInvariantAfter', prep: composePrep, steps: ['compose-generate'], statePath: 'deployments.0.costUsd' },
    expect: 'reticle-only',
  },
  {
    id: 'generate-blast-selected',
    category: 'state',
    intent: 'generating a script does not mutate the selected-deployment id',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'stateInvariantAfter', prep: composePrep, steps: ['compose-generate'], statePath: 'selectedId' },
    expect: 'reticle-only',
  },
  {
    id: 'generate-blast-drawer',
    category: 'state',
    intent: 'generating a script does not open the (off-screen) deployment drawer in state',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'stateInvariantAfter', prep: composePrep, steps: ['compose-generate'], statePath: 'drawerId' },
    expect: 'reticle-only',
  },
  {
    id: 'nav-blast-prompt',
    category: 'state',
    intent: 'navigating to Diagnostics does not corrupt the top deployment\'s internal checksum (never rendered)',
    setup: ['login-submit'],
    check: { kind: 'stateInvariantAfter', steps: ['nav-diagnostics'], statePath: 'deployments.0.checksum' },
    expect: 'reticle-only',
  },
  {
    id: 'nav-blast-title',
    category: 'state',
    intent: 'navigating to Diagnostics does not corrupt the top deployment\'s internal cost figure (never rendered)',
    setup: ['login-submit'],
    check: { kind: 'stateInvariantAfter', steps: ['nav-diagnostics'], statePath: 'deployments.0.costUsd' },
    expect: 'reticle-only',
  },
  {
    id: 'newdeploy-blast-kpi',
    category: 'state',
    intent: 'opening the new-deploy modal does not corrupt the top deployment\'s internal cost figure (never rendered)',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'stateInvariantAfter', steps: ['new-deploy'], statePath: 'deployments.0.costUsd' },
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
    check: { kind: 'netCountAfter', prep: composePrep, steps: ['compose-generate'], urlContains: '/api/generate-script', method: 'POST', expected: 1 },
    expect: 'both',
  },
  {
    id: 'forbidden-call',
    category: 'network',
    intent: 'generating a script never calls the forbidden /api/legacy-telemetry endpoint',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'netCountAfter', prep: composePrep, steps: ['compose-generate'], urlContains: '/api/legacy-telemetry', method: 'POST', expected: 0 },
    expect: 'both',
  },
  {
    id: 'compose-cors-leak',
    category: 'network',
    intent: 'generating a script never hits the forbidden cross-origin /api/broken/cors endpoint',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'netCountAfter', prep: composePrep, steps: ['compose-generate'], urlContains: '/api/broken/cors', method: 'GET', expected: 0 },
    expect: 'both',
  },
  {
    id: 'forbidden-500-newdeploy',
    category: 'network',
    intent: 'opening the new-deploy modal never fires a stray GET /api/broken/500',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'netCountAfter', steps: ['new-deploy'], urlContains: '/api/broken/500', method: 'GET', expected: 0 },
    expect: 'both',
  },
  {
    id: 'login-beacon',
    category: 'network',
    intent: 'signing in never fires the forbidden /api/legacy-telemetry privacy beacon',
    setup: [],
    check: { kind: 'netCountAfter', steps: ['login-submit'], urlContains: '/api/legacy-telemetry', method: 'POST', expected: 0 },
    expect: 'both',
  },
  {
    id: 'double-login',
    category: 'network',
    intent: 'signing in fires exactly one POST /api/login',
    setup: [],
    check: { kind: 'netCountAfter', steps: ['login-submit'], urlContains: '/api/login', method: 'POST', expected: 1 },
    expect: 'both',
  },
  {
    id: 'nav-beacon',
    category: 'network',
    intent: 'navigating to Overview never fires the forbidden /api/legacy-telemetry beacon',
    setup: ['login-submit'],
    check: { kind: 'netCountAfter', steps: ['nav-overview'], urlContains: '/api/legacy-telemetry', method: 'POST', expected: 0 },
    expect: 'both',
  },
  {
    id: 'double-fault-500',
    category: 'network',
    intent: 'the 500 fault button fires exactly one GET /api/broken/500',
    setup: ['login-submit', 'nav-diagnostics'],
    check: { kind: 'netCountAfter', steps: ['fault-500'], urlContains: '/api/broken/500', method: 'GET', expected: 1 },
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
    intent: 'an unrelated Compose action must not corrupt the top deployment\'s internal cost (1200)',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'stateEqualsAfter', prep: composePrep, steps: ['compose-generate'], statePath: 'deployments.0.costUsd', expected: 1200 },
    expect: 'reticle-only',
  },
  {
    id: 'kpi-success-tamper',
    category: 'business-logic',
    intent: 'an unrelated Compose action must not corrupt the top deployment\'s internal checksum ("9a3f00")',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'stateEqualsAfter', prep: composePrep, steps: ['compose-generate'], statePath: 'deployments.0.checksum', expected: '9a3f00' },
    expect: 'reticle-only',
  },
  {
    id: 'kpi-p95-tamper',
    category: 'business-logic',
    intent: 'an unrelated Compose action must not corrupt the second deployment\'s internal cost (1215)',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'stateEqualsAfter', prep: composePrep, steps: ['compose-generate'], statePath: 'deployments.1.costUsd', expected: 1215 },
    expect: 'reticle-only',
  },
  {
    id: 'kpi-services-tamper',
    category: 'business-logic',
    intent: 'an unrelated Compose action must not corrupt the second deployment\'s internal checksum ("9a3f01")',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'stateEqualsAfter', prep: composePrep, steps: ['compose-generate'], statePath: 'deployments.1.checksum', expected: '9a3f01' },
    expect: 'reticle-only',
  },
  {
    id: 'create-wrong-author',
    category: 'business-logic',
    intent: 'a created deployment records the correct internal checksum ("2328"), not a corrupted one',
    setup: ['login-submit', 'nav-deployments', 'new-deploy'],
    check: { kind: 'stateEqualsAfter', prep: namePrep, steps: ['deploy-submit'], statePath: 'deployments.0.checksum', expected: '2328' },
    expect: 'reticle-only',
  },
  {
    id: 'create-wrong-createdat',
    category: 'business-logic',
    intent: 'a created deployment records the correct internal cost (0, not yet costed), not a bogus figure',
    setup: ['login-submit', 'nav-deployments', 'new-deploy'],
    check: { kind: 'stateEqualsAfter', prep: namePrep, steps: ['deploy-submit'], statePath: 'deployments.0.costUsd', expected: 0 },
    expect: 'reticle-only',
  },

  // ── regression (?reticle-break-click): the control resolves green, but its handler is dead ───────
  {
    id: 'regress-deadclick-generate',
    category: 'regression',
    intent: 'clicking Generate actually fires the POST /api/generate-script (handler not dead)',
    url: `${APP_ORIGIN}/?reticle-break-click=compose-generate`,
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'netCountAfter', prep: composePrep, steps: ['compose-generate'], urlContains: '/api/generate-script', method: 'POST', expected: 1 },
    expect: 'both',
  },
  {
    id: 'regress-deadclick-login',
    category: 'regression',
    intent: 'clicking Sign in actually fires the POST /api/login (handler not dead)',
    url: `${APP_ORIGIN}/?reticle-break-click=login-submit`,
    setup: [],
    check: { kind: 'netCountAfter', steps: ['login-submit'], urlContains: '/api/login', method: 'POST', expected: 1 },
    expect: 'both',
  },
];
