import { describe, expect, it } from 'vitest';
import {
  isDeterminismProfile,
  ResumeStrategy,
  resumeStrategy,
  type DeterminismProfile,
} from './determinism.js';

/**
 * Resume is a WEB answer that the rest of the protocol had been inheriting.
 *
 * "Resume is nearly free — re-drive the prefix at 27ms a step" is true of a browser and false
 * somewhere it matters: on a service a POST is not idempotent, and on hardware re-driving a prefix
 * moves a physical arm. A protocol that silently re-drove a payment or a servo would be a defect,
 * not a feature, and nothing in the interface said which kind of subject it was talking to.
 *
 * So the realm DECLARES, and the strategy is derived. The discipline is the same one `channels()`
 * carries: declaring a property you do not have is the lie the conformance suite exists to catch —
 * and here the lie costs a re-sent payment rather than a wrong verdict.
 */

const profile = (over: Partial<DeterminismProfile> = {}): DeterminismProfile => ({
  reset: 'cheap',
  replayPrefix: 'free',
  time: 'injectable',
  observation: 'exact',
  actions: 'reversible',
  ...over,
});

describe('what a realm’s determinism profile says about resuming', () => {
  it('re-drives the prefix when the realm says that is free', () => {
    expect(resumeStrategy(profile({ replayPrefix: 'free' }))).toBe(ResumeStrategy.REPLAY_PREFIX);
  });

  it('resets first when re-driving is merely costly and a reset is available', () => {
    expect(resumeStrategy(profile({ replayPrefix: 'costly', reset: 'cheap' }))).toBe(
      ResumeStrategy.RESET_THEN_REPLAY,
    );
  });

  it('still re-drives when a reset is not available at all', () => {
    // Resetting is not a way out if there is no reset; the honest answer is that resuming costs.
    expect(resumeStrategy(profile({ replayPrefix: 'costly', reset: 'none' }))).toBe(
      ResumeStrategy.REPLAY_PREFIX,
    );
  });

  it('REFUSES when re-driving the prefix is unsafe', () => {
    // The gate. A POST is not idempotent and a servo does not un-move.
    expect(resumeStrategy(profile({ replayPrefix: 'unsafe' }))).toBe(ResumeStrategy.REFUSE);
  });

  it('refuses whatever else the profile says, because unsafe is not a cost to weigh', () => {
    expect(resumeStrategy(profile({ replayPrefix: 'unsafe', reset: 'cheap' }))).toBe(
      ResumeStrategy.REFUSE,
    );
  });
});

/**
 * A profile that is not a profile has to be refused, not defaulted.
 *
 * `resumeStrategy` reads `replayPrefix` and falls through to re-driving the prefix for anything it
 * does not recognise — which is the right default for a value it trusts, and the WRONG answer for a
 * value nobody declared. An implementation that stubbed `determinism()` with `{}` would be handed
 * "re-drive freely" by silence, on a subject that might be a payment service.
 *
 * So the shape is checked where the declaration is first read, exactly as a conformance binding
 * checks that `describe()` answers at all.
 */
describe('a declaration that is not one', () => {
  it('accepts a complete profile', () => {
    expect(isDeterminismProfile(profile())).toBe(true);
  });

  it('rejects an empty object, which would otherwise read as "re-drive freely"', () => {
    expect(isDeterminismProfile({})).toBe(false);
  });

  it('rejects a profile missing any single field', () => {
    for (const key of ['reset', 'replayPrefix', 'time', 'observation', 'actions'] as const) {
      const partial: Record<string, unknown> = { ...profile() };
      delete partial[key];
      expect(isDeterminismProfile(partial), key).toBe(false);
    }
  });

  it('rejects a value outside the declared vocabulary', () => {
    expect(isDeterminismProfile({ ...profile(), replayPrefix: 'probably-fine' })).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isDeterminismProfile(undefined)).toBe(false);
    expect(isDeterminismProfile('free')).toBe(false);
  });
});
