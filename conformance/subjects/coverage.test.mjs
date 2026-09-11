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
});
