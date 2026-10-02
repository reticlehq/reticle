import { describe, expect, it } from 'vitest';
import { learnFromRun, GuardState } from './learned-guards.js';

/**
 * A flow gets stricter every time it runs, without anybody writing a new assertion.
 *
 * The assertions a user writes by hand are the ones they thought of. The defects a drive actually
 * finds are the ones the app really has, and today they are reported once and forgotten: the next
 * replay of the same flow is exactly as blind to them as the first was. So a bug can be found, fixed
 * and silently return, and the flow that found it the first time says nothing.
 *
 * The loop that fixes this has to be careful in one specific way, and it is the reason this is a
 * pure function with tests rather than a line in the replay path.
 *
 * A contradiction observed RIGHT NOW is not an assertion. Asserting "this must not happen" while it
 * is happening makes the flow red on a defect the user already knows about, which trains them to
 * ignore it. And asserting "this DOES happen" is worse — it pins broken behaviour as expected, which
 * is a regression test that fires when somebody FIXES the bug.
 *
 * So a finding is remembered as an OPEN issue, and it only becomes a guard at the moment the run
 * stops showing it — the one moment the fix is a fact rather than a hope. From then on its return is
 * a regression, and that is the compounding: every defect this flow has ever seen and survived
 * becomes something it can never quietly reacquire.
 */
const seen = (kind: string, step = 0) => ({ kind, step });

describe('learnFromRun', () => {
  it('remembers a new contradiction as an OPEN issue, not as an assertion', () => {
    const r = learnFromRun({ guards: [], seen: [seen('request-never-settled')] });
    expect(r.guards).toHaveLength(1);
    expect(r.guards[0]?.state).toBe(GuardState.OPEN);
    expect(r.promoted).toHaveLength(0);
  });

  it('does NOT assert a defect that is currently happening', () => {
    // Asserting "must not happen" while it happens makes the flow red on a known bug, and a check
    // that is red for a reason the user already accepted is a check they learn to ignore.
    const r = learnFromRun({ guards: [], seen: [seen('stale-response-applied')] });
    // The length first, because `[].every()` is TRUE: without this the assertion below holds just as
    // well for a run that forgot the finding entirely, and deleting the push that records it leaves
    // this whole file green. Proved by doing exactly that.
    expect(r.guards).toHaveLength(1);
    expect(r.guards.every((g) => g.state === GuardState.OPEN)).toBe(true);
  });

  it('does NOT promote on a single clean run — one absence is not a fix', () => {
    /*
     * Found by driving, not by reasoning. Replaying a real flow three times, a
     * `request-never-settled` appeared in run 1 and not in run 2 — and the first version of this
     * rule promoted it on the spot. That defect was not fixed between two replays a second apart;
     * it is INTERMITTENT, and a guard minted from one quiet run reports every later appearance as
     * a regression. Flakiness would arrive dressed as a code change.
     */
    const before = [{ kind: 'request-never-settled', step: 0, state: GuardState.OPEN }];
    const r = learnFromRun({ guards: before, seen: [] });
    expect(r.guards[0]?.state).toBe(GuardState.OPEN);
    expect(r.guards[0]?.cleanRuns).toBe(1);
    expect(r.promoted).toHaveLength(0);
  });

  it('PROMOTES once the defect has stayed away, not merely gone away', () => {
    const before = [
      { kind: 'request-never-settled', step: 0, state: GuardState.OPEN, cleanRuns: 1 },
    ];
    const r = learnFromRun({ guards: before, seen: [] });
    expect(r.guards[0]?.state).toBe(GuardState.GUARDED);
    expect(r.promoted).toEqual(['request-never-settled']);
  });

  it('resets the count when the defect reappears — consecutive, not cumulative', () => {
    // Two separate quiet runs with a failure between them say "intermittent", not "fixed".
    const before = [
      { kind: 'request-never-settled', step: 0, state: GuardState.OPEN, cleanRuns: 1 },
    ];
    const r = learnFromRun({ guards: before, seen: [seen('request-never-settled')] });
    expect(r.guards[0]?.state).toBe(GuardState.OPEN);
    expect(r.guards[0]?.cleanRuns).toBe(0);
  });

  it('keeps a guard guarded when the run is clean — the normal case, and it is silent', () => {
    const before = [{ kind: 'duplicate-request', step: 1, state: GuardState.GUARDED }];
    const r = learnFromRun({ guards: before, seen: [] });
    expect(r.guards[0]?.state).toBe(GuardState.GUARDED);
    expect(r.promoted).toHaveLength(0);
    expect(r.regressed).toHaveLength(0);
  });

  it('REPORTS A REGRESSION when a guarded defect comes back', () => {
    // The whole point. This flow proved once that this defect was gone; it is back.
    const before = [{ kind: 'duplicate-request', step: 1, state: GuardState.GUARDED }];
    const r = learnFromRun({ guards: before, seen: [seen('duplicate-request', 1)] });
    expect(r.regressed).toEqual(['duplicate-request']);
    expect(r.guards[0]?.state).toBe(GuardState.GUARDED);
  });

  it('tells a defect at one step from the same defect at another', () => {
    // `duplicate-request` at the login step and at the checkout step are different bugs.
    const before = [{ kind: 'duplicate-request', step: 1, state: GuardState.GUARDED }];
    const r = learnFromRun({ guards: before, seen: [seen('duplicate-request', 4)] });
    expect(r.regressed).toHaveLength(0);
    expect(r.guards).toHaveLength(2);
  });

  it('never records the same issue twice', () => {
    const before = [{ kind: 'request-never-settled', step: 0, state: GuardState.OPEN }];
    const r = learnFromRun({ guards: before, seen: [seen('request-never-settled')] });
    expect(r.guards).toHaveLength(1);
  });

  it('a blind run does not promote, however many steps it ran', () => {
    /*
     * The seam supplying this flag got it wrong first, and the wrongness is the reason to state it
     * twice. It passed `steps.length > 0`, which is true of essentially every replay — including one
     * where no observer attached and `seen` is empty because NOTHING WAS WATCHING. Two of those in a
     * row promoted an open defect into a guard: a guard minted from absence of evidence, which is
     * precisely what this function refuses when it is told the truth and cannot refuse when it is
     * told "some steps ran". It now reads whether any step carries a digest.
     */
    const before = [{ kind: 'duplicate-request', step: 3, state: GuardState.OPEN, cleanRuns: 1 }];
    const blind = learnFromRun({ guards: before, seen: [], observed: false });
    expect(blind.promoted).toHaveLength(0);
    expect(blind.guards[0]?.state).toBe(GuardState.OPEN);
    // …and the same input from a run that DID observe is the promotion. Same guards, same empty
    // `seen`, opposite answers — which is the whole point of the flag.
    const sighted = learnFromRun({ guards: before, seen: [], observed: true });
    expect(sighted.promoted).toEqual(['duplicate-request']);
  });

  it('learns nothing from a run that observed nothing, rather than promoting everything', () => {
    // A run that could not observe is not a run that found the app clean. Promoting on it would
    // manufacture guards out of an absence of evidence — the false green, one level up.
    const before = [{ kind: 'request-never-settled', step: 0, state: GuardState.OPEN }];
    const r = learnFromRun({ guards: before, seen: [], observed: false });
    expect(r.guards[0]?.state).toBe(GuardState.OPEN);
    expect(r.promoted).toHaveLength(0);
  });
});
