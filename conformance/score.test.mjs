import { describe, expect, it } from 'vitest';
import { SCENARIOS, Profile } from './scenarios/index.mjs';
import {
  Outcome,
  declarationMatchesHandshake,
  profileEarned,
  report,
  requiredScenarios,
} from './score.mjs';

/**
 * The rules that decide what an implementation earned.
 *
 * Every one of these exists because of a specific way a suite like this goes wrong, and each is
 * checked here rather than trusted. None of them needs a bridge, a browser or an app -- which is the
 * reason the rules live apart from the thing that drives an implementation.
 */

const ALL_CHANNELS = ['net', 'log', 'state', 'signal', 'ui'];
const allPassing = (profile) =>
  Object.fromEntries(requiredScenarios(profile).map((s) => [s.id, Outcome.PASSED]));

describe('what an implementation earned', () => {
  it('earns the profile it can answer for', () => {
    const registered = { name: 'x', profile: Profile.SURFACE, channels: ALL_CHANNELS };
    expect(profileEarned(registered, allPassing(Profile.SURFACE))).toBe(Profile.SURFACE);
  });

  it('earns a lower profile rather than nothing, when it answered that much', () => {
    // The whole reason there are profiles. An implementation that cannot address things on screen
    // is not a worse implementation, it is a different one, and it should be able to say so.
    const registered = {
      name: 'x',
      profile: Profile.IN_REALM,
      channels: ['net', 'log', 'state', 'signal'],
    };
    expect(profileEarned(registered, allPassing(Profile.IN_REALM))).toBe(Profile.IN_REALM);
  });

  it('does not count a scenario that could not be planted as a pass', () => {
    // The failure this project has already watched happen to its own benchmark: a scenario stops
    // being plantable, quietly leaves the denominator, and the headline number stays perfect.
    const outcomes = allPassing(Profile.EFFECT);
    const [first] = requiredScenarios(Profile.EFFECT);
    outcomes[first.id] = Outcome.ABSENT;
    const registered = { name: 'x', profile: Profile.EFFECT, channels: ['net', 'log'] };
    expect(profileEarned(registered, outcomes)).toBeUndefined();
  });

  it('earns nothing without the negative control, however much else it answered', () => {
    // Almost every scenario asks for something OTHER than a confident yes. An implementation that
    // answers "I could not tell" to everything satisfies nearly all of them, and is useless.
    const outcomes = allPassing(Profile.EFFECT);
    const control = SCENARIOS.find((s) => s.isNegativeControl === true);
    outcomes[control.id] = Outcome.FAILED;
    const registered = { name: 'x', profile: Profile.EFFECT, channels: ['net', 'log'] };
    expect(profileEarned(registered, outcomes)).toBeUndefined();
  });

  it('earns nothing for a profile whose channels it never declared', () => {
    // A profile is a claim about what you can see, not only about what you managed to answer.
    const outcomes = allPassing(Profile.SURFACE);
    const registered = { name: 'x', profile: Profile.SURFACE, channels: ['net', 'log'] };
    expect(profileEarned(registered, outcomes)).not.toBe(Profile.SURFACE);
  });
});

describe('what an implementation said about itself', () => {
  it('accepts a registration that matches the handshake', () => {
    expect(
      declarationMatchesHandshake({ channels: ['net', 'log'] }, { channels: ['net', 'log'] }),
    ).toEqual([]);
  });

  it('objects when it registered a channel it never declared on connect', () => {
    // The declaration is the first assertion. An implementation claiming a channel it cannot
    // observe would be offered scenarios it should never have seen.
    const problems = declarationMatchesHandshake(
      { channels: ['net', 'log', 'ui'] },
      { channels: ['net', 'log'] },
    );
    expect(problems.join(' ')).toContain('ui');
  });

  it('objects the other way too', () => {
    const problems = declarationMatchesHandshake(
      { channels: ['net'] },
      { channels: ['net', 'state'] },
    );
    expect(problems.join(' ')).toContain('state');
  });
});

describe('the report', () => {
  it('names what could not be planted, every time', () => {
    // Not decoration. A report that gives only a grade lets a shrinking suite look like a steady one.
    const outcomes = allPassing(Profile.EFFECT);
    const [first, second] = requiredScenarios(Profile.EFFECT);
    outcomes[first.id] = Outcome.ABSENT;
    delete outcomes[second.id];
    const result = report(
      { name: 'x', profile: Profile.EFFECT, channels: ['net', 'log'] },
      outcomes,
    );
    expect(result.couldNotBePlanted).toContain(first.id);
    expect(result.neverAttempted).toContain(second.id);
    expect(result.earned).toBeUndefined();
  });
});

describe('the scenario list itself', () => {
  it('has a negative control, without which nothing else means anything', () => {
    expect(SCENARIOS.filter((s) => s.isNegativeControl === true).length).toBeGreaterThan(0);
  });

  it('gives every scenario a behaviour to plant and a reason for existing', () => {
    // Described as behaviours, never as fixture code -- that is what makes them portable to a
    // platform nobody here has seen.
    const thin = SCENARIOS.filter((s) => s.plant.length < 20 || s.why.length < 20);
    expect(thin.map((s) => s.id)).toEqual([]);
  });

  it('ships the ones we do not pass, rather than quietly leaving them out', () => {
    // A suite whose author passes everything is a suite shaped around its author.
    expect(SCENARIOS.filter((s) => s.knownFailingForUs === true).length).toBeGreaterThan(0);
  });

  it('gives every scenario a unique name', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });
});
