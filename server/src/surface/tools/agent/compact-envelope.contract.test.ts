import { describe, expect, it } from 'vitest';
import { compactSequence, compactVerdict, shapeForAgent } from './compact-envelope.js';
import { ReticleTool } from '@reticlehq/core';

/**
 * The decisive-evidence contract: compaction may drop bulk, never a key that decides anything.
 *
 * A token optimisation once shipped a false green (the `lean` profile, CLAUDE.md "accuracy outranks
 * tokens"). So this is a PROPERTY over generated verdict results — every combination of the decisive
 * fields, present or absent, green or red — not a snapshot of one: the compact envelope must carry
 * every decisive value the full one has, at the place an agent reads it, with the same value.
 */

/** Deterministic PRNG, so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, items: readonly T[]): T => items[Math.floor(r() * items.length)] as T;
const maybe = <T>(r: Rand, value: T): T | undefined => (r() < 0.5 ? value : undefined);
const defined = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));

function netEvidence(r: Rand): Record<string, unknown> {
  return defined({
    method: pick(r, ['GET', 'POST', 'DELETE']),
    url: 'http://localhost:8787/api/keys?x=1',
    status: pick(r, [200, 201, 400, 500]),
    ok: r() < 0.5,
    bodyMatched: maybe(r, { projectId: 'bench-app' }),
    durationMs: pick(r, [12, 2400]),
    initiatorStack: maybe(r, ['at a (x.js:1)', 'at b (y.js:2)']),
    requestShape: maybe(r, { keys: ['name'] }),
    contentType: maybe(r, 'application/json'),
    statusText: maybe(r, 'OK'),
  });
}

function fullResult(r: Rand): Record<string, unknown> {
  const pass = r() < 0.5;
  const verified = pass ? pick(r, ['yes', 'unknown', 'no-fault']) : pick(r, ['no', 'unknown']);
  const evidence = pick(r, [
    { name: 'auth:granted', data: { email: 'a@b.c' } },
    netEvidence(r),
    [netEvidence(r), netEvidence(r)],
    { ref: 'e4', name: 'Save', states: ['enabled'] },
    { from: '/login', to: '/dashboard' },
    { caseMiss: 'Trial', presentTestids: ['plan'] },
    undefined,
  ]);
  return defined({
    next: maybe(r, 'Done driving? reticle_session { action: "yield" } hands the tab back.'),
    verified,
    verifiedReason: pick(r, ['proved', 'assertion_failed', 'unclean_capture']),
    because: 'the declared consequence did not hold',
    alreadyTrueEvidence: maybe(r, { name: 'x' }),
    effect: defined({
      ok: true,
      ref: 'e9',
      action: 'click',
      dispatched: pick(r, [true, false]),
      settled: pick(r, [true, false]),
      settleReason: pick(r, [null, 'timeout']),
      testid: 'login-submit',
      component: 'Login',
      role: 'button',
      name: 'Sign in',
      warning: maybe(r, 'real-input-fell-back'),
      effect: defined({
        focusMoved: 'e8->e9',
        domMutatedWithin: pick(r, [0, 16]),
        appeared: maybe(r, 'Signing in…'),
        occluded: maybe(r, true),
      }),
      source: maybe(r, { file: 'src/Login.tsx', line: 81, column: 8 }),
    }),
    verdict: defined({
      pass,
      evidence,
      failureReason: pass ? undefined : 'no signal matched',
      observed: pass ? undefined : "signal 'x' never fired",
      expected: pass ? undefined : "signal 'x' to fire",
      assertion: pass ? undefined : 'signal.absent',
      observationLost: maybe(r, true),
      inconclusive: maybe(r, 'tab throttled'),
      caseOnlyMiss: maybe(r, true),
    }),
    source: pass ? undefined : maybe(r, 'src/Login.tsx:81'),
    trace: { window_ms: 66, summary: { total: 26, network: 1, signals: 1 } },
    capsuleSaved: maybe(r, 'cap-1'),
    summary: defined({
      net: defined({
        total: 2,
        errors: pick(r, [0, 1]),
        headline: maybe(r, 'POST /api/save 500'),
        ignoredDevTooling: maybe(r, 3),
      }),
      consoleErrors: pick(r, [0, 2]),
      firstConsoleError: maybe(r, 'TypeError: x is undefined'),
      requests: maybe(r, ['POST /api/login 200']),
      statePathsChanged: ['app'],
      storageKeysChanged: maybe(r, ['token']),
      stateDiffs: [{ path: 'auth', from: null, to: '{"email":"a"}', atMs: 4 }],
      storageDiffs: [],
      route: maybe(r, '/dashboard'),
      signals: maybe(r, ['auth:granted']),
      layoutShift: 0.006,
      longTasks: 0,
      truncated: maybe(r, true as const),
      stateUnwatched: maybe(r, true as const),
      elided: maybe(r, { stateDiffs: 3 }),
      ignoredBookkeeping: maybe(r, 7),
    }),
    instrumentationGaps: maybe(r, [
      { kind: 'no-flow-intent', missing: 'm', cost: 'c', fix: 'f' },
      { kind: 'no-source-mapping', repeat: true },
    ]),
    contradictions: maybe(r, [{ kind: 'ui-advanced-write-failed', claim: 'a', counter: 'b' }]),
    durable: maybe(r, { held: true }),
    honesty: defined({
      grade: pick(r, ['signal', 'presence', 'net']),
      attribution: 'window',
      coverage: pick(r, [
        { pct: 100, partial: false },
        { pct: 60, partial: true, note: 'cross-origin frame' },
      ]),
      settled: pick(r, [true, false]),
      integrity: pick(r, [
        { clean: true, issues: [] },
        { clean: false, issues: ['buffer_loss'] },
      ]),
    }),
    capsule: maybe(r, {
      firstDivergence: { expected: { kind: 'signal' }, observed: 'x' },
      blastRadius: ['net POST /a'],
    }),
    blastRadius: maybe(r, ['state app', 'net DELETE http://localhost:8787/api/keys']),
    since: 4009,
    sessionId: maybe(r, 's2'),
    session: maybe(r, { lastSeenMs: 3, throttled: true, focused: false }),
    screenshot: pick(r, [{ path: '/tmp/0003.jpg', source: 'browser' }, { reason: 'no provider' }]),
    warning: maybe(r, 'tab is throttled'),
    version_skew: maybe(r, { pair: 'daemon', action: 'run `npx @reticlehq/server stop`' }),
  });
}

const rec = (v: unknown): Record<string, unknown> =>
  'object' === typeof v && null !== v && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Strip the transport keys the contract allows to go, recursively — what evidence must still equal. */
const NOISE = new Set(['initiatorStack', 'requestShape', 'contentType', 'statusText']);
function decidingEvidence(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decidingEvidence);
  if ('object' !== typeof v || null === v) return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(
        ([k, x]) => !NOISE.has(k) && !('durationMs' === k && 'number' === typeof x && x < 1000),
      )
      .map(([k, x]) => [k, decidingEvidence(x)]),
  );
}

/** Every decisive value of a FULL result, read where the full envelope keeps it. */
function decisiveOfFull(full: Record<string, unknown>): Record<string, unknown> {
  const verdict = rec(full['verdict']);
  const summary = rec(full['summary']);
  const net = rec(summary['net']);
  const effect = rec(full['effect']);
  const honesty = rec(full['honesty']);
  const src = rec(effect['source']);
  return {
    verified: full['verified'],
    verifiedReason: full['verifiedReason'],
    because: full['because'],
    pass: verdict['pass'],
    failureReason: verdict['failureReason'],
    observed: verdict['observed'],
    expected: verdict['expected'],
    assertion: verdict['assertion'],
    observationLost: verdict['observationLost'],
    inconclusive: verdict['inconclusive'],
    caseOnlyMiss: verdict['caseOnlyMiss'],
    evidence: decidingEvidence(verdict['evidence']),
    contradictions: full['contradictions'],
    integrity: honesty['integrity'],
    grade: honesty['grade'],
    partialCoverage: true === rec(honesty['coverage'])['partial'] ? honesty['coverage'] : undefined,
    unsettled: false === honesty['settled'] ? false : undefined,
    consoleErrors: 0 === summary['consoleErrors'] ? undefined : summary['consoleErrors'],
    firstConsoleError: summary['firstConsoleError'],
    failedRequests: 0 === net['errors'] ? undefined : net['errors'],
    failedHeadline: 0 === net['errors'] ? undefined : net['headline'],
    truncated: summary['truncated'],
    stateUnwatched: summary['stateUnwatched'],
    elided: summary['elided'],
    source:
      full['source'] ??
      ('string' === typeof src['file'] ? `${src['file']}:${String(src['line'])}` : undefined),
    ref: effect['ref'],
    dispatchedFalse: false === effect['dispatched'] ? false : undefined,
    settledFalse: false === effect['settled'] ? false : undefined,
    warning: effect['warning'],
    capsule: full['capsule'],
    capsuleSaved: full['capsuleSaved'],
    alreadyTrueEvidence: full['alreadyTrueEvidence'],
    durable: full['durable'],
    since: full['since'],
    sessionId: full['sessionId'],
    session: full['session'],
    sessionWarning: full['warning'],
    versionSkew: full['version_skew'],
    screenshotPath: rec(full['screenshot'])['path'],
    freshGaps: Array.isArray(full['instrumentationGaps'])
      ? full['instrumentationGaps'].filter((g) => true !== rec(g)['repeat'])
      : undefined,
    undeclaredRequests: Array.isArray(full['blastRadius'])
      ? full['blastRadius'].filter((b) => String(b).startsWith('net '))
      : undefined,
  };
}

/** The same values, read where the COMPACT envelope keeps them. */
function decisiveOfCompact(c: Record<string, unknown>): Record<string, unknown> {
  const verdict = rec(c['verdict']);
  const summary = rec(c['summary']);
  const net = rec(summary['net']);
  const effect = rec(c['effect']);
  const honesty = rec(c['honesty']);
  return {
    verified: c['verified'],
    verifiedReason: c['verifiedReason'],
    because: c['because'],
    pass: verdict['pass'],
    failureReason: verdict['failureReason'],
    observed: verdict['observed'],
    expected: verdict['expected'],
    assertion: verdict['assertion'],
    observationLost: verdict['observationLost'],
    inconclusive: verdict['inconclusive'],
    caseOnlyMiss: verdict['caseOnlyMiss'],
    evidence: verdict['evidence'],
    contradictions: c['contradictions'],
    integrity: honesty['integrity'],
    grade: honesty['grade'],
    partialCoverage: honesty['coverage'],
    unsettled: honesty['settled'],
    consoleErrors: summary['consoleErrors'],
    firstConsoleError: summary['firstConsoleError'],
    failedRequests: net['errors'],
    failedHeadline: net['headline'],
    truncated: summary['truncated'],
    stateUnwatched: summary['stateUnwatched'],
    elided: summary['elided'],
    source: c['source'],
    ref: c['ref'],
    dispatchedFalse: effect['dispatched'],
    settledFalse: effect['settled'],
    warning: effect['warning'],
    capsule: c['capsule'],
    capsuleSaved: c['capsuleSaved'],
    alreadyTrueEvidence: c['alreadyTrueEvidence'],
    durable: c['durable'],
    since: c['since'],
    sessionId: c['sessionId'],
    session: c['session'],
    sessionWarning: c['warning'],
    versionSkew: c['version_skew'],
    screenshotPath: rec(c['screenshot'])['path'],
    freshGaps: c['instrumentationGaps'],
    undeclaredRequests: c['blastRadius'],
  };
}

const RUNS = 2000;

describe('compact envelope: decisive-evidence contract', () => {
  it(`keeps every decisive value of ${String(RUNS)} generated verdicts`, () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const full = fullResult(rng(seed));
      const compact = compactVerdict(full);
      const want = decisiveOfFull(full);
      const got = decisiveOfCompact(compact);
      // An empty fresh-gap list and an absent one say the same thing.
      if (Array.isArray(want['freshGaps']) && 0 === want['freshGaps'].length)
        want['freshGaps'] = undefined;
      if (Array.isArray(want['undeclaredRequests']) && 0 === want['undeclaredRequests'].length)
        want['undeclaredRequests'] = undefined;
      // A green's undeclared requests are kept only beside a `changed` line; without one the whole
      // blast radius stays.
      if (compact['changed'] === undefined) got['undeclaredRequests'] = want['undeclaredRequests'];
      expect(got, `seed ${String(seed)}`).toEqual(want);
    }
  });

  it('is idempotent, so a wrapped call compacted twice reads the same', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const once = compactVerdict(fullResult(rng(seed)));
      expect(compactVerdict(once), `seed ${String(seed)}`).toEqual(once);
    }
  });

  it('never invents a key: everything it emits was in the full result or is the changed line', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const full = fullResult(rng(seed));
      for (const key of Object.keys(compactVerdict(full))) {
        expect(['changed', 'ref', 'source', ...Object.keys(full)]).toContain(key);
      }
    }
  });

  it('keeps an unknown top-level field: compaction drops by name, never allow-lists', () => {
    const full = { ...fullResult(rng(7)), someFutureFinding: { kind: 'new' } };
    expect(compactVerdict(full)['someFutureFinding']).toEqual({ kind: 'new' });
  });

  it('is shorter on every generated result', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const full = fullResult(rng(seed));
      expect(JSON.stringify(compactVerdict(full)).length).toBeLessThan(JSON.stringify(full).length);
    }
  });

  // Compaction is opt-in: the agent-loop A/B did not show the compact arm at least as accurate.
  it('only `detail: "compact"` compacts; the default, `full` and non-agent callers are untouched', () => {
    const full = fullResult(rng(3));
    expect(shapeForAgent(ReticleTool.ACT_AND_WAIT, {}, full, true)).toBe(full);
    expect(shapeForAgent(ReticleTool.ACT_AND_WAIT, { detail: 'full' }, full, true)).toBe(full);
    expect(shapeForAgent(ReticleTool.ACT_AND_WAIT, { detail: 'compact' }, full, false)).toBe(full);
    expect(shapeForAgent(ReticleTool.OBSERVE, { detail: 'compact' }, full, true)).toBe(full);
    expect(shapeForAgent(ReticleTool.ACT_AND_WAIT, { detail: 'compact' }, full, true)).not.toBe(
      full,
    );
  });

  it('a sequence keeps every step outcome, observed/expected and contradiction', () => {
    const step = {
      ref: 'e1',
      action: 'click',
      dispatched: true,
      settled: true,
      settleReason: null,
      testid: 't',
      component: 'C',
      role: 'button',
      name: 'Go',
      source: { file: 'a.tsx', line: 3 },
      window: { since: 1, until: 9 },
      digest: { total: 40 },
      contradictions: [{ kind: 'x' }],
      expected: "signal 'a'",
      held: false,
      observed: 'never fired',
      screenshot: { path: '/p.jpg', source: 'browser' },
    };
    const out = compactSequence({ verified: 'no', because: 'b', steps: [step] });
    expect(out['steps']).toEqual([
      {
        ref: 'e1',
        action: 'click',
        source: 'a.tsx:3',
        window: { since: 1, until: 9 },
        contradictions: [{ kind: 'x' }],
        expected: "signal 'a'",
        held: false,
        observed: 'never fired',
        screenshot: { path: '/p.jpg' },
      },
    ]);
  });
});

describe('forgiving parse, strict verdict: the result names the aliases it normalised', () => {
  it('adds `normalized` for an aliased until, in compact and full alike, and never changes the verdict', () => {
    const full = { verified: 'no', because: 'b', verdict: { pass: false }, since: 1 };
    const args = { until: { kind: 'route', pathContains: '/settings' } };
    const compact = shapeForAgent(ReticleTool.ACT_AND_WAIT, args, full, true) as Record<
      string,
      unknown
    >;
    expect(compact['normalized']).toEqual(['route.pathContains → contains']);
    expect(compact['verified']).toBe('no');
    const asFull = shapeForAgent(
      ReticleTool.ACT_AND_WAIT,
      { ...args, detail: 'full' },
      full,
      true,
    ) as Record<string, unknown>;
    expect(asFull['normalized']).toEqual(['route.pathContains → contains']);
  });
  it('names step expects by index', () => {
    const out = shapeForAgent(
      ReticleTool.ACT,
      { steps: [{ ref: 'e1', action: 'click', expect: { type: 'signal', name: 'x' } }] },
      { verified: 'yes', because: 'b', steps: [] },
      true,
    ) as Record<string, unknown>;
    expect(out['normalized']).toEqual(['step 0: type → kind']);
  });
});

describe('the A/B control arm', () => {
  it('RETICLE_RESULT_DETAIL=compact compacts every agent call; a call can still ask for full', () => {
    const full = { verified: 'yes', because: 'b', trace: { window_ms: 1 }, since: 1 };
    process.env['RETICLE_RESULT_DETAIL'] = 'compact';
    try {
      expect(shapeForAgent(ReticleTool.ACT_AND_WAIT, {}, full, true)).not.toBe(full);
      expect(shapeForAgent(ReticleTool.ACT_AND_WAIT, { detail: 'full' }, full, true)).toBe(full);
    } finally {
      delete process.env['RETICLE_RESULT_DETAIL'];
    }
    expect(shapeForAgent(ReticleTool.ACT_AND_WAIT, {}, full, true)).toBe(full);
  });
});
