// HONESTY-CRITICAL: prove the instrumentation-gap surface works against a REAL app in a REAL
// browser — that an absence in the app which weakened a verdict is reported with the change that
// would fix it, and, just as importantly, that a verdict nothing weakened reports nothing at all.
//
// The unit tests pin the rule. They cannot pin the wiring: whether the facts the act and assert
// paths gather actually reach the rule, whether the field survives the tool's outputSchema, and
// whether a gap raised on one call is still open on the next. Every one of those has a way of being
// correct in isolation and absent end to end — which is the failure this repo has paid for before,
// where gates passed and the feature did not work when driven.
//
// next-smoke is a WELL-INSTRUMENTED fixture — `useReticleStore('page', …)` at
// `apps/next-smoke/app/page.tsx:20` registers a store, and the build plugin stamps source. That
// makes it the right fixture for both halves: the gap that genuinely applies here must fire, and
// the gaps that do not apply must stay silent. A finding surface is only worth having if it is
// quiet on an app that did the work.
//
// An earlier version of this spec expected `no-store-registered`, reading a comment at page.tsx:15
// ("there is no store object to hand registerStore") as meaning no store was registered. The line
// below it registers one. The spec was wrong and the product was right — which is the whole reason
// a rule gets driven against a real app and not only unit-tested.
import { chromium } from 'playwright';
import { start, TOOLS } from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';

let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

// The battery gives every spec :4400. Overridable so this can also be run by hand on a machine
// where an agent's own MCP daemon already holds that port — killing that one takes the agent's
// tooling down with it, which is a documented way to lose an afternoon.
const PORT = Number(process.env.RETICLE_PORT ?? 4400);
const server = await start({ port: PORT, mcp: false });
// The coverage tool reads and raises the project's best observability. Stubbed rather than written
// to disk: this spec is about the gap surface, and a real store would make it depend on what an
// earlier run left behind.
let raised = null;
const deps = {
  sessions: server.bridge.sessions,
  project: {
    recordRoutes: async () => {},
    bestObservability: async () => undefined,
    raiseObservability: async (percent) => {
      raised = percent;
    },
  },
};
const T = (n, a = {}) =>
  TOOLS.find((t) => t.name === n).handler(deps, { sessionId: 'next-smoke', ...a });

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://localhost:3100/');
await waitForSession(() => server.bridge.sessions.list(), 'next-smoke');

console.log('\n=== INSTRUMENT: a gap is reported where it cost this verdict something ===');
chk(
  'app SDK connected',
  server.bridge.sessions.list().some((s) => s.sessionId === 'next-smoke'),
);

// ── The positive: a red verdict with nothing to point at ────────────────────────────────────────
// No act preceded this assertion, so there is no file:line for the failure — which is exactly the
// round trip the agent is about to spend, and exactly what a build plugin removes permanently.
const stateAssert = await T('reticle_assert', {
  predicate: { kind: 'state', path: 'somethingNobodyRegistered' },
  timeout_ms: 2000,
});
const gaps = stateAssert.instrumentationGaps ?? [];
const sourceGap = gaps.find((g) => g.kind === 'no-source-mapping');

chk('a failing verdict with no source to point at reports a gap', sourceGap !== undefined, `kinds=${gaps.map((g) => g.kind).join(',') || 'none'}`);
chk('the gap says what could not be seen', typeof sourceGap?.missing === 'string' && sourceGap.missing.length > 0, sourceGap?.missing);
chk('the gap says what it cost THIS verdict', typeof sourceGap?.cost === 'string' && sourceGap.cost.length > 0);
chk(
  'the gap names the change that would close it, not a general instruction',
  typeof sourceGap?.fix === 'string' && sourceGap.fix.includes('plugin'),
  sourceGap?.fix,
);

// The other half of not crying wolf: this app DOES register a store, so a state assertion against
// it must NOT claim one is missing. A surface that reports every kind on every red is noise.
chk(
  'no store gap on an app that registers a store',
  gaps.every((g) => g.kind !== 'no-store-registered'),
  `kinds=${gaps.map((g) => g.kind).join(',') || 'none'}`,
);

// ── The negative control: a verdict nothing weakened must report nothing ─────────────────────────
// Without this the spec would pass just as well against a version that always reports a gap, which
// is the failure mode that makes a finding surface worthless.
const cleanAssert = await T('reticle_assert', {
  predicate: { kind: 'console', level: 'error', absent: true },
  timeout_ms: 2000,
});
chk(
  'a passing assertion that asked about nothing missing reports NO gap',
  (cleanAssert.instrumentationGaps ?? []).length === 0,
  `verified=${cleanAssert.verified} gaps=${(cleanAssert.instrumentationGaps ?? []).length}`,
);

// ── The ledger: a gap raised on one call is still open when the agent asks "am I done?" ──────────
await T('reticle_assert', {
  predicate: { kind: 'state', path: 'somethingNobodyRegistered' },
  timeout_ms: 2000,
});
const coverage = await T('reticle_verify', { action: 'coverage' });
chk('reticle_verify reports the open gap', (coverage.instrumentationGaps ?? []).length > 0);
chk('and says verification is not finished for a reason driving cannot fix', coverage.unproven === true);
chk('coverage carries an observability block', typeof coverage.observability === 'object');

// ── And it CLOSES: the mechanism only works if fixing a gap changes the answer ───────────────────
// A ledger that never forgets would punish the agent that instrumented the app, which is the exact
// behaviour the release exists to cause.
await T('reticle_assert', { predicate: { kind: 'console', level: 'error', absent: true }, timeout_ms: 2000 });
const after = await T('reticle_verify', { action: 'coverage' });
chk(
  'a later verdict with nothing missing closes the gap',
  (after.instrumentationGaps ?? []).length === 0 && after.unproven === undefined,
  `gaps=${(after.instrumentationGaps ?? []).length} unproven=${String(after.unproven)}`,
);

console.log(
  `\n${fail === 0 ? '✅ INSTRUMENTATION GAP VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`,
);
await b.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
