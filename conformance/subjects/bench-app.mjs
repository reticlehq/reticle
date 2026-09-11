/**
 * The subject this project supplies, so the suite can be run against this project.
 *
 * The suite inverts the plant contract on purpose: it cannot inject a defect into an application
 * it does not own, so an implementation ships a small app and says how to put it into each
 * scenario's state. This is ours. It is data, not code -- a scenario id, how to plant it, and the
 * claim to make once it is planted.
 *
 * ── WHY NOT ALL FOURTEEN ────────────────────────────────────────────────────────────────────────
 * Nine scenarios have no entry, and that is the point of publishing the file. A scenario with no
 * plant is scored ABSENT, never passed, and ABSENT is what an honest scoreboard looks like while
 * a subject is incomplete. Listing only the nine we can plant and calling the run green would be
 * a scoreboard shaped around its author, which is the failure this suite exists to be incapable
 * of.
 *
 * The gap is the FIXTURE, not the implementation. `apps/bench-app` carries seventy-three injected
 * regressions reachable as `?reticle-bug=<id>`, and five of them happen to be the behaviours five
 * scenarios describe. The other nine describe behaviours nobody built a bug for, because the
 * catalogue was grown for a benchmark and not for this.
 */

/** How a scenario is planted: a bug to inject, or nothing at all for the clean cases. */
export const BENCH_APP_SUBJECT = Object.freeze({
  /**
   * A request fails and the screen moves on anyway -- the swallowed rejection.
   *
   * `swallowed-500-login` makes the login POST answer 500 while the UI advances to the signed-in
   * state. Every channel except the network agrees it worked.
   */
  'effect-failed-surface-advanced': {
    bug: 'swallowed-500-login',
    act: { capability: 'act', target: 'testid=login-submit' },
    claim: 'the sign-in completed',
    reads: ['net'],
  },

  /** One action, two identical writes, against a claim that named one. */
  'double-submit-against-count-one': {
    bug: 'double-submit',
    act: { capability: 'act', target: 'testid=login-submit' },
    claim: 'exactly one sign-in request was made',
    reads: ['net'],
  },

  /**
   * The thing being watched goes away before the window closes.
   *
   * `slow-then-drop` starts a request and loses it. The observer leaves, which is a fact about
   * the observation and never a fault in the app -- a scenario that exists because blaming the
   * app for that is the commonest way a check becomes a liar.
   */
  'subject-disappears-mid-window': {
    bug: 'slow-then-drop',
    act: { capability: 'act', target: 'testid=login-submit' },
    claim: 'the sign-in completed',
    reads: ['net'],
  },

  /**
   * Nothing wrong at all, and a real claim about a real consequence.
   *
   * The mandatory negative control. Without it, an implementation answering "I could not tell" to
   * everything satisfies nearly every other scenario on the list, because almost all of them ask
   * for something OTHER than a confident yes.
   */
  'healthy-app-real-claim': {
    bug: undefined,
    act: { capability: 'act', target: 'testid=login-submit' },
    claim: 'the sign-in completed',
    reads: ['net'],
  },

  /** A clean, quiet window in which nobody claimed anything. */
  'nothing-declared': {
    bug: undefined,
    act: undefined,
    claim: undefined,
    reads: [],
  },
});

/** Scenario ids this subject can put the app into. Everything else is scored ABSENT. */
export function plantable() {
  return Object.keys(BENCH_APP_SUBJECT);
}

/** The URL that puts the app into a scenario's state, or undefined if we cannot plant it. */
export function plantUrl(base, scenario) {
  const entry = BENCH_APP_SUBJECT[scenario];
  if (entry === undefined) return undefined;
  return entry.bug === undefined ? base : `${base}?reticle-bug=${entry.bug}`;
}
