import { describe, expect, it } from 'vitest';
import { answersScenario, driveAll, driveScenario, PLANT_COMMAND } from './drive.mjs';
import { Outcome } from './score.mjs';
import { Profile, SCENARIOS, Verdict } from './scenarios/index.mjs';

/**
 * The driver, tested without anything to drive.
 *
 * A conformance suite is a measuring instrument, and an unchecked measuring instrument is just a
 * confident number. These use a fake client so every branch that decides a score can be exercised
 * with no browser, no process and no network -- which is also what lets them live in the fast gate
 * rather than behind a real run.
 */

const CLAIM = { id: 'c1' };

function client({ plant = () => ({ planted: true, claim: CLAIM }), verify = () => ({}), hello }) {
  return {
    hello: async () => hello ?? { channels: ['net', 'log'] },
    command: async (name, args) => {
      expect(name).toBe(PLANT_COMMAND);
      return plant(args);
    },
    verify: async (claim) => verify(claim),
  };
}

const scenario = (over = {}) => ({
  id: 's1',
  profile: Profile.EFFECT,
  plant: 'something',
  mustProduce: { verdict: Verdict.NO },
  ...over,
});

describe('an answer is scored against what the scenario required', () => {
  it('passes when the verdict matches', () => {
    expect(answersScenario(scenario(), { verdict: Verdict.NO })).toBe(true);
  });

  it('fails when it does not', () => {
    expect(answersScenario(scenario(), { verdict: Verdict.YES })).toBe(false);
  });

  it('compares the ground only when the scenario named one', () => {
    // The deciding CLAUSE, as a code. Pinning an implementation's own wording would score it on
    // vocabulary rather than behaviour, and `no` alone is too coarse: a scenario about a
    // contradiction would also be satisfied by a merely failed assertion.
    const withGround = scenario({ mustProduce: { verdict: Verdict.NO, ground: 'contradicted' } });
    expect(answersScenario(withGround, { verdict: Verdict.NO, ground: 'contradicted' })).toBe(true);
    expect(answersScenario(withGround, { verdict: Verdict.NO, ground: 'assertion-failed' })).toBe(
      false,
    );
    expect(answersScenario(scenario(), { verdict: Verdict.NO, ground: 'anything' })).toBe(true);
  });

  it('honours notVerdict, which most scenarios use', () => {
    // Most of this list asks for something OTHER than a confident yes, rather than for one
    // specific answer -- because there is usually more than one honest thing to say.
    const s = scenario({ mustProduce: { notVerdict: Verdict.YES } });
    expect(answersScenario(s, { verdict: Verdict.UNKNOWN })).toBe(true);
    expect(answersScenario(s, { verdict: Verdict.YES })).toBe(false);
  });

  it('honours neverProduce even when the required verdict was given', () => {
    const s = scenario({ mustProduce: { verdict: Verdict.UNKNOWN }, neverProduce: Verdict.NO });
    expect(answersScenario(s, { verdict: Verdict.NO })).toBe(false);
  });
});

describe('anything that stops us asking is ABSENT, never FAILED', () => {
  it('records a refused plant as absent', async () => {
    const result = await driveScenario(
      client({ plant: () => ({ planted: false, reason: 'cannot plant this here' }) }),
      scenario(),
    );
    expect(result.outcome).toBe(Outcome.ABSENT);
    expect(result.note).toBe('cannot plant this here');
  });

  it('records a throwing plant as absent', async () => {
    const result = await driveScenario(
      client({
        plant: () => {
          throw new Error('boom');
        },
      }),
      scenario(),
    );
    expect(result.outcome).toBe(Outcome.ABSENT);
  });

  it('records a throwing verify as absent, not as a wrong answer', async () => {
    // The implementation did not give a wrong answer. It gave no answer, and those are different
    // facts about it.
    const result = await driveScenario(
      client({
        verify: () => {
          throw new Error('socket died');
        },
      }),
      scenario(),
    );
    expect(result.outcome).toBe(Outcome.ABSENT);
  });

  it('abandons a scenario that runs long, and calls it absent', async () => {
    const result = await driveScenario(
      client({ verify: () => new Promise(() => {}) }),
      scenario(),
      { timeoutMs: 10 },
    );
    expect(result.outcome).toBe(Outcome.ABSENT);
    expect(result.note).toBe('timed out');
  });
});

describe('the handshake is checked before anything is driven', () => {
  it('refuses to score an implementation that declared something it did not register', async () => {
    const out = await driveAll(client({ hello: { channels: ['net', 'log', 'ui'] } }), {
      name: 'x',
      profile: Profile.EFFECT,
      channels: ['net', 'log'],
    });
    expect(out.earned).toBeUndefined();
    expect(out.rejected?.join(' ')).toContain('ui');
    // And nothing was attempted, so no accidental pass can be credited.
    expect(out.neverAttempted).toHaveLength(SCENARIOS.length);
  });

  it('drives everything once the declaration matches', async () => {
    const out = await driveAll(client({ verify: () => ({ verdict: Verdict.UNKNOWN }) }), {
      name: 'x',
      profile: Profile.EFFECT,
      channels: ['net', 'log'],
    });
    expect(out.rejected).toBeUndefined();
    expect(out.neverAttempted).toHaveLength(0);
  });
});

describe('the suite cannot be satisfied by answering unknown to everything', () => {
  it('withholds the profile from an implementation that never commits', async () => {
    // The reason the negative control is mandatory. Almost every scenario asks for something other
    // than a confident yes, so "I could not tell" satisfies nearly all of them.
    const out = await driveAll(client({ verify: () => ({ verdict: Verdict.UNKNOWN }) }), {
      name: 'timid',
      profile: Profile.EFFECT,
      channels: ['net', 'log'],
    });
    expect(out.earned).toBeUndefined();
  });
});
