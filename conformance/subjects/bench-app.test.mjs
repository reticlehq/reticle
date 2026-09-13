import { describe, expect, it } from 'vitest';
import { BENCH_APP_CHANNELS, BENCH_APP_SUBJECT, plantable, plantUrl } from './bench-app.mjs';
import { CHANNELS_REQUIRED, Profile, SCENARIOS } from '../scenarios/index.mjs';

/**
 * The subject file, checked against the scenarios it claims to plant.
 *
 * A subject map is the one place an implementation can cheat without anybody noticing: name a
 * scenario it cannot really produce, and the driver will drive it, get whatever the app happens
 * to do, and score that as an answer. So the two things worth pinning are that every id here is
 * a real scenario, and that being absent from here is a deliberate, visible state rather than an
 * oversight.
 */

describe('the subject only claims scenarios that exist', () => {
  it('names no scenario the suite does not define', () => {
    const known = new Set(SCENARIOS.map((s) => s.id));
    const invented = plantable().filter((id) => !known.has(id));
    expect(
      invented,
      'These are in the subject map and in no scenario. A plant for a scenario nobody scores is ' +
        'dead weight; a typo here silently drops a scenario to ABSENT.',
    ).toEqual([]);
  });

  it('includes the negative control, or the whole run means nothing', () => {
    // Almost every scenario asks for something OTHER than a confident yes, so an implementation
    // answering "I could not tell" to everything satisfies nearly all of them. The control is
    // the one scenario that requires a commitment.
    const control = SCENARIOS.find((s) => s.isNegativeControl === true);
    expect(control).toBeDefined();
    expect(plantable()).toContain(control?.id);
  });

  it('is honest about the majority it cannot plant', () => {
    // Not an aspiration. Nine of fourteen have no entry, they are scored ABSENT rather than
    // passed, and the file says why. A subject map that grew to cover everything by loosening
    // what counts as planting would be worse than this one.
    expect(plantable().length).toBeLessThan(SCENARIOS.length);
  });
});

describe('planting is a URL, and an unplantable scenario says so', () => {
  it('adds the injected bug for a scenario that needs one', () => {
    expect(plantUrl('http://app', 'double-submit-against-count-one')).toContain(
      'reticle-bug=double-login',
    );
  });

  it('leaves the app clean for a scenario whose point is that nothing is wrong', () => {
    expect(plantUrl('http://app', 'healthy-app-real-claim')).toBe('http://app');
  });

  it('returns undefined rather than a plausible URL when it cannot plant', () => {
    // The dangerous failure would be returning the base URL here: the driver would plant
    // nothing, drive a healthy app, and score the answer as though the behaviour were present.
    expect(plantUrl('http://app', 'fire-and-forget')).toBeUndefined();
  });

  it('every entry that names a bug also says what to claim about it', () => {
    for (const [id, entry] of Object.entries(BENCH_APP_SUBJECT)) {
      if (entry.bug === undefined) continue;
      expect(entry.claim, `${id} plants a bug and claims nothing`).toBeDefined();
      expect(entry.reads.length, `${id} claims nothing readable`).toBeGreaterThan(0);
    }
  });
});

/**
 * Why this subject claims `effect` and not more, pinned so the reason cannot rot into a comment
 * that used to be true.
 *
 * The registration in `run-self.mjs` carries a careful note about understating and overstating
 * the CHANNELS, and directly beneath it the profile sat as a bare constant with no reason at
 * all. The measurement is that channels are not what holds the claim down -- they satisfy every
 * profile including `surface` -- and fixtures are. If that ever stops being true, the comment
 * beside the claim is wrong and this says so.
 */
describe('what profile this subject could claim, and why it does not', () => {
  it('declares enough channels for every profile, so the claim is not a capability limit', () => {
    for (const profile of Object.values(Profile)) {
      const missing = (CHANNELS_REQUIRED[profile] ?? []).filter(
        (c) => !BENCH_APP_CHANNELS.includes(c),
      );
      expect(missing, `${String(profile)} needs channels this subject never declares`).toEqual([]);
    }
  });

  it('cannot plant anything above effect, which is what actually holds the claim down', () => {
    const above = SCENARIOS.filter((s) => s.profile !== Profile.EFFECT);
    expect(above.length, 'no scenarios above effect, so this test proves nothing').toBeGreaterThan(
      0,
    );
    // Negative control, because an empty result here is also what a broken `plantUrl` returns,
    // and the two would look identical. An `effect` scenario must still come back with a URL.
    expect(
      plantUrl('http://x', 'effect-failed-surface-advanced'),
      'plantUrl answers nothing at all, so the assertion below proves nothing',
    ).toBeDefined();
    // The day one of these gets a planter, the claim should rise with it -- and this test is
    // what fails to say so, rather than the claim quietly staying low beside a stale comment.
    const planted = above.filter((s) => plantUrl('http://x', s.id) !== undefined);
    expect(
      planted.map((s) => s.id),
      'this subject can now plant a scenario above `effect` — raise the claimed profile in ' +
        'run-self.mjs, and delete this expectation for the ones it covers',
    ).toEqual([]);
  });
});
