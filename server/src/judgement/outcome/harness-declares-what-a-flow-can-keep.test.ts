import { describe, expect, it } from 'vitest';
import { consequencesFor } from '@/features/harness/jev-driver.js';
import { PredicateSchema } from '@reticlehq/engine/question/predicate/predicate.js';

/**
 * The two ends of one promise, checked against each other.
 *
 * A drive declares a consequence BEFORE it acts, and the verdict engine decides whether it held.
 * That half has always worked. The other half is that the declaration is saved into the flow, so
 * every later replay re-checks the same claim for no model cost at all — which is the entire
 * argument for recording a drive.
 *
 * It was not working, and nothing could see it, because the two halves are in different packages
 * with their own green tests: the driver's tests assert what it declares, the recorder's assert
 * what it keeps, and neither asks whether the thing declared is a thing that can be kept. Measured
 * on a real dashboard: 0 of 22 steps across 16 machine-driven flows carried an expectation, against
 * 211 of 419 in the hand-authored flows beside them. Every consequence on offer was unbound -- a
 * bare `signal`, a bare `net`, an `anyOf`, a `not` -- and the recorder drops all four, correctly,
 * because a replay cannot re-check any of them.
 *
 * So this is the check that spans the seam. It is not asking for perfection: a drive-only
 * consequence is a legitimate trade (the negated route is the reason a nav-heavy app stopped
 * reporting 21 false reds) and is declared as such. It asks only that the field SAYS which it is,
 * and that at least one offer is always savable, so a drive can never again be silently unable to
 * leave a regression test behind.
 */

/**
 * Can a saved flow carry this? Since `FlowStep.expect` became a `Predicate`, the answer is "any
 * predicate the schema accepts" — there is no longer a second, narrower format to squeeze through.
 */
const savable = (predicate: Record<string, unknown>): boolean =>
  PredicateSchema.safeParse(predicate).success;

describe('what the harness declares and what a flow can keep', () => {
  const offers = consequencesFor('/settings', ['export:generated', 'order:placed']);

  it('offers something at all', () => {
    expect(Object.keys(offers).length).toBeGreaterThan(0);
  });

  /*
   * The field is a PROMISE, and this checks the promise is never broken: anything marked recordable
   * really can be saved. It used to be a biconditional, because the flat format could not hold an
   * `anyOf` or a `not` and the two had to agree exactly on what was impossible.
   *
   * Nothing is impossible any more. A predicate round-trips whole, negations included, so the two
   * offers still marked `recordable: false` are a judgement that they are not WORTH saving rather
   * than a statement that they cannot be — and that judgement is the harness's to make, not this
   * migration's. Worth revisiting on its own terms now that the constraint behind it is gone.
   */
  it('never promises a consequence a flow could not keep', () => {
    const wrong = Object.entries(offers)
      .filter(([, c]) => c.recordable && !savable(c.predicate))
      .map(([name, c]) => `${name}: recordable=${String(c.recordable)} but the recorder disagrees`);
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  /**
   * The property that was broken. Every offer being drive-only is exactly the state that produced
   * sixteen flows asserting nothing, and it reads as success from both sides of the seam.
   */
  it('always offers at least one consequence a saved flow can carry', () => {
    const savable = Object.entries(offers).filter(([, c]) => c.recordable);
    expect(savable.length).toBeGreaterThan(0);
  });

  it('offers a savable consequence even for an app that declares no signals', () => {
    const bare = consequencesFor(undefined, []);
    expect(Object.values(bare).some((c) => c.recordable)).toBe(true);
  });

  /** The app's own words are the strongest claim available, and the only signal form that saves. */
  it('names the declared signals rather than claiming that some signal fires', () => {
    const named = Object.entries(offers).find(([name]) => name.includes('export:generated'));
    expect(named).toBeDefined();
    expect(named?.[1].predicate).toEqual({ kind: 'signal', name: 'export:generated' });
    expect(named?.[1].recordable).toBe(true);
  });

  /** A contract can declare dozens; a prompt that lists all of them is a prompt nobody can weigh. */
  it('caps how many declared signals become choices', () => {
    const many = Array.from({ length: 40 }, (_, i) => `sig:${String(i)}`);
    const capped = Object.keys(consequencesFor('/x', many)).filter((k) => k.startsWith('signal '));
    expect(capped.length).toBeLessThanOrEqual(6);
  });

  /**
   * Kept deliberately, and the reason is written where somebody deleting it will read it: without
   * this, every nav link on a client-routed app is handed a declaration it cannot satisfy.
   *
   * The second assertion INVERTED, and that is the migration showing through. A negation had no
   * representation the flat format could hold, so "drive-only" was a fact about the file. A
   * predicate keeps a `not` whole, so it is now a fact about what we choose to offer.
   */
  it('keeps the route negation drive-only, though the format could now save it', () => {
    expect(offers['navigates']?.recordable).toBe(false);
    expect(savable(offers['navigates']?.predicate ?? {})).toBe(true);
  });
});
