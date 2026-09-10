/**
 * Deciding what an implementation earned.
 *
 * Kept apart from the thing that drives it on purpose. Driving an implementation needs a bridge, a
 * process to start and a wire to speak; deciding what the results mean needs none of that. Splitting
 * them is what lets every rule below be checked without any of it running.
 *
 * The rules are short and each one exists because of a specific way a suite like this goes wrong.
 */

import { CHANNELS_REQUIRED, Profile, SCENARIOS } from './scenarios/index.mjs';

/** What happened when a scenario was attempted. */
export const Outcome = {
  /** The behaviour was planted and the implementation said what it had to say. */
  PASSED: 'passed',
  /** The behaviour was planted and the implementation said something else. */
  FAILED: 'failed',
  /**
   * The behaviour could not be planted, so nothing was learned.
   *
   * NEVER counted as a pass. A scenario that stops being plantable and leaves the denominator is how
   * a scoreboard stays perfect while quietly testing less every month -- this project has watched
   * exactly that happen to its own benchmark.
   */
  ABSENT: 'absent',
};

/** Profiles from the least demanding upward, which is the order they are earned in. */
const PROFILES_IN_ORDER = [Profile.EFFECT, Profile.IN_REALM, Profile.SURFACE];

/**
 * Does what the implementation declared at connect time match what it registered?
 *
 * The declaration is itself the first assertion. An implementation that claims a channel it cannot
 * observe would otherwise be scored on scenarios it should never have been offered, and would fail
 * them for the wrong reason -- or worse, pass one by accident. Catching the lie at the handshake is
 * the one place this class of problem can be caught structurally rather than one constant at a time.
 */
export function declarationMatchesHandshake(registered, handshake) {
  const missing = (registered.channels ?? []).filter(
    (c) => !(handshake.channels ?? []).includes(c),
  );
  const extra = (handshake.channels ?? []).filter((c) => !(registered.channels ?? []).includes(c));
  const problems = [];
  if (missing.length > 0)
    problems.push(`registered but not declared on connect: ${missing.join(', ')}`);
  if (extra.length > 0)
    problems.push(`declared on connect but not registered: ${extra.join(', ')}`);
  return problems;
}

/** The scenarios an implementation of this profile is required to answer. */
export function requiredScenarios(profile) {
  const upTo = PROFILES_IN_ORDER.slice(0, PROFILES_IN_ORDER.indexOf(profile) + 1);
  return SCENARIOS.filter((s) => upTo.includes(s.profile));
}

/**
 * The highest profile this implementation earned, or none.
 *
 * Three rules, and the second and third are the ones that stop this being a participation trophy:
 *
 * 1. Every scenario the profile requires must have PASSED. Absent is not passed.
 * 2. The negative control must have passed. Without it, an implementation that answers "I could not
 *    tell" to everything satisfies every other scenario on the list, because almost all of them ask
 *    for something OTHER than a confident yes.
 * 3. The channels the profile requires must actually be declared. A profile is a claim about what
 *    you can see, not only about what you answered.
 */
export function profileEarned(registered, outcomes) {
  let earned;
  for (const profile of PROFILES_IN_ORDER) {
    const channels = CHANNELS_REQUIRED[profile] ?? [];
    const hasChannels = channels.every((c) => (registered.channels ?? []).includes(c));
    if (!hasChannels) break;

    const required = requiredScenarios(profile);
    const allPassed = required.every((s) => outcomes[s.id] === Outcome.PASSED);
    if (!allPassed) break;

    const control = required.find((s) => s.isNegativeControl === true);
    if (control === undefined || outcomes[control.id] !== Outcome.PASSED) break;

    earned = profile;
  }
  return earned;
}

/**
 * A full report: what was earned, and everything that was not answered.
 *
 * The unanswered list is not decoration. A scoreboard that reports only a grade lets a shrinking
 * suite look like a steady one, so what could not be planted is named every time.
 */
export function report(registered, outcomes) {
  const attempted = requiredScenarios(registered.profile ?? Profile.EFFECT);
  return {
    name: registered.name,
    claimed: registered.profile,
    earned: profileEarned(registered, outcomes),
    failed: attempted.filter((s) => outcomes[s.id] === Outcome.FAILED).map((s) => s.id),
    couldNotBePlanted: attempted.filter((s) => outcomes[s.id] === Outcome.ABSENT).map((s) => s.id),
    neverAttempted: attempted.filter((s) => outcomes[s.id] === undefined).map((s) => s.id),
  };
}
