// Central bug registry for the Playwright-vs-Reticle benchmark.
//
// Each bug is injected into apps/bench-app via ?reticle-bug=<id> (see reticle-bug-injector.ts).
// Every bug carries ONE intent-level check that a harness must verify. A harness "detects" the bug
// when its check correctly FAILS on the buggy build (and must NOT fail on the clean build — that
// would be a false positive). The `expect` field is the ground-truth capability line: which harness
// class CAN catch it, so the scorecard can separate "missed" from "not-expected-to-catch".
//
// Check kinds (interpreted by each harness in its own capability):
//   usable              — element {testid} must be visible, non-zero, un-occluded, pointer-cursor.
//   paint               — full-page pixels must match the clean baseline (screenshot territory).
//   domCountMatchesState— DOM badge {testid} text must equal store path {statePath} (needs app state).
//   consoleCleanAfter   — after clicking {steps}, no console.error in the window.
//   netCountAfter       — after clicking {steps}, exactly {expected} requests match {urlContains}.
//   stateInvariantAfter — after clicking {steps}, store path {statePath} is unchanged (blast radius).
//
// `setup` = testids to click (in order) to reach the screen before checking. Login is pre-filled,
// so clicking `login-submit` authenticates.

export const APP_ORIGIN = 'http://localhost:4312';

/** Build the fixture URL for a bug id (empty id = clean build). */
export function bugUrl(id) {
  return id ? `${APP_ORIGIN}/?reticle-bug=${encodeURIComponent(id)}` : `${APP_ORIGIN}/`;
}

export const BUGS = [
  {
    id: 'invisible',
    category: 'ui-visual',
    intent: 'the "New deploy" button is usable (a real user can see and click it)',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'usable', testid: 'new-deploy' },
    expect: 'both', // opacity:0 — visible via computed style to either tool
  },
  {
    id: 'occluded',
    category: 'ui-visual',
    intent: 'the "New deploy" button is usable (nothing covers it)',
    setup: ['login-submit', 'nav-deployments'],
    check: { kind: 'usable', testid: 'new-deploy' },
    expect: 'both', // transparent overlay — hit-testing catches it
  },
  {
    id: 'paint-filter',
    category: 'ui-paint',
    intent: 'the page renders with the correct colors (no global paint regression)',
    setup: ['login-submit'],
    check: { kind: 'paint' },
    expect: 'playwright-only', // computed styles unchanged; only a pixel diff sees the hue-rotate
  },
  {
    id: 'state-desync',
    category: 'state',
    intent: 'the Deployments nav badge shows the real deployment count from the store',
    setup: ['login-submit'],
    check: { kind: 'domCountMatchesState', testid: 'nav-deployments', statePath: 'deployments' },
    expect: 'reticle-only', // DOM number looks plausible; only store read reveals the lie
  },
  {
    id: 'console-leak',
    category: 'console',
    intent: 'generating a script does not emit a console error',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'consoleCleanAfter', prep: { fill: 'compose-prompt', text: 'benchmark note' }, steps: ['compose-generate'] },
    expect: 'both', // console listener catches it in either tool
  },
  {
    id: 'double-submit',
    category: 'network',
    intent: 'generating a script fires exactly one POST /api/generate-script',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'netCountAfter', prep: { fill: 'compose-prompt', text: 'benchmark note' }, steps: ['compose-generate'], urlContains: '/api/generate-script', method: 'POST', expected: 1 },
    expect: 'both', // request listener / network buffer counts the duplicate
  },
  {
    id: 'mutation-leak',
    category: 'state-blast-radius',
    intent: 'generating a script does not corrupt the top deployment status in the store',
    setup: ['login-submit', 'nav-compose'],
    check: { kind: 'stateInvariantAfter', prep: { fill: 'compose-prompt', text: 'benchmark note' }, steps: ['compose-generate'], statePath: 'deployments.0.status' },
    expect: 'reticle-only', // unrelated store path; invisible in DOM, only a state invariant catches it
  },
];
