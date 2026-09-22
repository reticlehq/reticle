import { describe, expect, it } from 'vitest';
import { Profile, SCENARIOS } from '../scenarios/index.mjs';
import { requiredScenarios } from '../score.mjs';
import { plantUrl } from './bench-app.mjs';
import { ELECTRON_SMOKE_SUBJECT } from './electron-smoke.mjs';
import { CLI_SMOKE_SUBJECT } from './cli-smoke.mjs';

/**
 * What the three subjects reach TOGETHER, which no single runner could say.
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
 * The first subject here that is not a page.
 *
 * No DOM, no request to intercept, no screen to photograph -- which is what makes it worth having
 * beyond the two scenarios it uniquely plants: until it existed, the claim that the adjudicator is
 * realm-blind had only ever been tested against browsers.
 */
const CLI = IN_PROFILE.filter((id) => CLI_SMOKE_SUBJECT[id] !== undefined);

/**
 * Planted by neither subject.
 *
 * Named rather than counted, and asserted by equality rather than by `<=`, for the reason
 * MUTUAL_PAIRS_TODAY is: a bound quietly accepts the list growing back. Adding a planter should
 * fail this test and make somebody delete a line, which is the only edit that records progress.
 */
const PLANTED_NOWHERE = ['accepted-but-not-finished'];

describe('what the web and desktop subjects reach between them', () => {
  it('reads both subject maps, so an empty answer cannot mean it read nothing', () => {
    expect(IN_PROFILE.length).toBeGreaterThan(5);
    expect(WEB.length).toBeGreaterThan(0);
    expect(DESKTOP.length).toBeGreaterThan(0);
    expect(CLI.length).toBeGreaterThan(0);
  });

  it('is complementary rather than nested — each surface reaches something the other cannot', () => {
    // If this ever became nested, the desktop run would be costing three minutes of Electron to
    // re-answer a subset of what a browser tab already answered, and the honest thing would be
    // to say so rather than keep printing two scores.
    // `effect-failed-surface-advanced` joined this list when the web subject's entry for it was
    // removed. The entry planted `swallowed-500-login`, which does not swallow anything: the app
    // shows an error and stays put, so the scenario was never being exercised on the web surface.
    // The desktop subject still plants it for real -- the Tauri app's `ipc://archive_todo` returns
    // 500 while the list advances -- which is why the id is here rather than in PLANTED_NOWHERE.
    expect(DESKTOP.filter((id) => !WEB.includes(id)).sort()).toEqual([
      'effect-failed-surface-advanced',
      'fire-and-forget',
    ]);
    expect(WEB.filter((id) => !DESKTOP.includes(id)).sort()).toEqual([
      'double-submit-against-count-one',
      'subject-disappears-mid-window',
      'verifier-ran-out-of-budget',
    ]);
  });

  /**
   * What only the command-line subject can put an implementation into.
   *
   * Both entries were published gaps rather than oversights. `consequence-already-true` was the
   * one ground no run of this suite had ever reached, and `outcome-in-an-unwatched-place` had no
   * entry on any subject -- the README said so in as many words.
   *
   * Neither needed a defect invented for it. A build run twice IS the first, and a tool writing
   * outside the roots somebody declared IS the second, which is the distinction that scenario
   * exists to keep: the write really happens, and the verifier really cannot see it.
   */
  it('names what the command-line subject reaches and the two page subjects cannot', () => {
    const pages = new Set([...WEB, ...DESKTOP]);
    expect(CLI.filter((id) => !pages.has(id)).sort()).toEqual([
      'consequence-already-true',
      'outcome-in-an-unwatched-place',
    ]);
  });

  it('names exactly the scenarios no subject can plant, on any surface', () => {
    const union = new Set([...WEB, ...DESKTOP, ...CLI]);
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
   * `already-true` is CLOSED, and closing it took both halves. It was reachable by nothing: no
   * subject could plant `consequence-already-true`, and separately no implementation set
   * `consequenceHeldBefore` -- either gap alone was enough. A realm that snapshots a filesystem
   * before it acts holds the before-state inherently, and a build run twice is the scenario, so
   * the command-line subject closed both at once and this line was deleted.
   *
   * What is left is two grounds that a second scenario asks for and cannot be planted; both are
   * reached by a scenario that can. The specification was never wrong to allow a gap here --
   * `undefined` on `consequenceHeldBefore` means NOBODY CHECKED, which is honest and conformant.
   * What was wrong was a release log claiming every clause is "driven by a real application".
   *
   * Equality, not a bound, for the same reason as the list above: closing either gap should
   * fail this test and make somebody delete a line.
   */
  it('names the grounds the whole suite cannot reach on any surface', () => {
    const union = new Set([...WEB, ...DESKTOP, ...CLI]);
    const unreachable = SCENARIOS.filter(
      (s) => s.mustProduce?.ground !== undefined && !union.has(s.id),
    ).map((s) => s.mustProduce.ground);
    expect([...new Set(unreachable)].sort()).toEqual(['contradicted', 'coverage-impeached']);
    // `contradicted` and `coverage-impeached` appear above only because a SECOND scenario asking
    // for them is unplantable; both are reached by a scenario that is.
    //
    // EVERY ground is now reachable by some scenario on some surface, and the empty array is the
    // fact worth keeping. It was `['already-true']` until the command-line subject arrived: that
    // clause was specified, had a `Ground`, had unit tests, and was fired by nothing, because no
    // subject could plant it and no implementation supplied `consequenceHeldBefore`. Asserted as
    // an equality rather than a bound, so a clause that stops being driven fails here instead of
    // quietly rejoining the list.
    const reachableGrounds = new Set(
      SCENARIOS.filter((s) => union.has(s.id)).map((s) => s.mustProduce?.ground),
    );
    expect([...new Set(unreachable)].filter((g) => !reachableGrounds.has(g))).toEqual([]);
  });
});
