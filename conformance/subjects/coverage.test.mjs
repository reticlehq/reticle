import { describe, expect, it } from 'vitest';
import { Profile, SCENARIOS } from '../scenarios/index.mjs';
import { requiredScenarios } from '../score.mjs';
import { plantUrl } from './bench-app.mjs';
import { ELECTRON_SMOKE_SUBJECT } from './electron-smoke.mjs';

/**
 * What the two subjects reach TOGETHER, which neither runner could say.
 *
 * `run-self.mjs` and `run-desktop.mjs` are separate processes that each print their own absent
 * list, so a reader of the web score sees `fire-and-forget: absent` with no way to learn that
 * it is exercised -- and answered -- on the desktop shell. The desktop subject file knew: it
 * carried a comment saying this is "the first case of the desktop shell covering something the
 * browser fixture cannot". A comment on one scenario, read by nothing.
 *
 * The union is computed from the two subject maps rather than from a run, so it is a statement
 * about the fixtures and cannot drift with a flaky shell. What it is FOR is the honest headline
 * the per-surface scores cannot produce: how much of the specification this project can put an
 * implementation into at all, on any surface it has.
 */

const IN_PROFILE = requiredScenarios(Profile.EFFECT).map((s) => s.id);
const WEB = IN_PROFILE.filter((id) => plantUrl('http://x', id) !== undefined);
const DESKTOP = IN_PROFILE.filter((id) => ELECTRON_SMOKE_SUBJECT[id] !== undefined);

/**
 * Planted by neither subject.
 *
 * Named rather than counted, and asserted by equality rather than by `<=`, for the reason
 * MUTUAL_PAIRS_TODAY is: a bound quietly accepts the list growing back. Adding a planter should
 * fail this test and make somebody delete a line, which is the only edit that records progress.
 */
const PLANTED_NOWHERE = [
  'consequence-already-true',
  'accepted-but-not-finished',
  'outcome-in-an-unwatched-place',
];

describe('what the web and desktop subjects reach between them', () => {
  it('reads both subject maps, so an empty answer cannot mean it read nothing', () => {
    expect(IN_PROFILE.length).toBeGreaterThan(5);
    expect(WEB.length).toBeGreaterThan(0);
    expect(DESKTOP.length).toBeGreaterThan(0);
  });

  it('is complementary rather than nested — each surface reaches something the other cannot', () => {
    // If this ever became nested, the desktop run would be costing three minutes of Electron to
    // re-answer a subset of what a browser tab already answered, and the honest thing would be
    // to say so rather than keep printing two scores.
    expect(DESKTOP.filter((id) => !WEB.includes(id))).toEqual(['fire-and-forget']);
    expect(WEB.filter((id) => !DESKTOP.includes(id)).sort()).toEqual([
      'double-submit-against-count-one',
      'subject-disappears-mid-window',
      'verifier-ran-out-of-budget',
    ]);
  });

  it('names exactly the scenarios no subject can plant, on any surface', () => {
    const union = new Set([...WEB, ...DESKTOP]);
    expect(IN_PROFILE.filter((id) => !union.has(id)).sort()).toEqual([...PLANTED_NOWHERE].sort());
  });

  it('every scenario named as unplantable is a real scenario', () => {
    // Otherwise a typo in the list above silently shrinks what this test checks.
    const ids = new Set(SCENARIOS.map((s) => s.id));
    for (const id of PLANTED_NOWHERE) expect(ids.has(id), `${id} is not a scenario`).toBe(true);
  });

  /**
   * The one clause no run can reach, named so it stops being a surprise.
   *
   * `already-true` is clause 10, added this release. It is specified, it has a `Ground`, and the
   * adjudicator has unit tests for it. It is also reachable by nothing: no subject can plant
   * `consequence-already-true`, and separately **no implementation sets
   * `consequenceHeldBefore`** -- `conformance-client.ts` supplies every other field on the
   * adjudication input and not that one. Either gap alone would be enough.
   *
   * The specification is not wrong to allow this: `undefined` there means NOBODY CHECKED, which
   * is honest and conformant. What was wrong was the release log claiming every clause is
   * "driven by a real application". Ten of eleven are.
   *
   * Equality, not a bound, for the same reason as the list above: closing either gap should
   * fail this test and make somebody delete a line.
   */
  it('names the grounds the whole suite cannot reach on any surface', () => {
    const union = new Set([...WEB, ...DESKTOP]);
    const unreachable = SCENARIOS.filter(
      (s) => s.mustProduce?.ground !== undefined && !union.has(s.id),
    ).map((s) => s.mustProduce.ground);
    expect([...new Set(unreachable)].sort()).toEqual([
      'already-true',
      'contradicted',
      'coverage-impeached',
    ]);
    // `contradicted` and `coverage-impeached` appear here only because a SECOND scenario asking
    // for them is unplantable; both are reached by a scenario that is. `already-true` is the
    // only ground with no reachable scenario at all, which is the fact worth keeping.
    const reachableGrounds = new Set(
      SCENARIOS.filter((s) => union.has(s.id)).map((s) => s.mustProduce?.ground),
    );
    expect([...new Set(unreachable)].filter((g) => !reachableGrounds.has(g))).toEqual([
      'already-true',
    ]);
  });
});
