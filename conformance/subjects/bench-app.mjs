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

/**
 * How a scenario is planted: a bug to inject, or nothing at all for the clean cases.
 *
 * `act` carries a VERB as well as a target. Naming the capability and the thing to point at is
 * not enough -- `act` answered `unknown action ''` to every plant, because "press this" and
 * "type into this" are different things to do to the same handle, and the specification's
 * `Action` carries parameters for exactly that reason.
 */
export const BENCH_APP_SUBJECT = Object.freeze({
  /**
   * A request fails and the screen moves on anyway -- the swallowed rejection.
   *
   * `swallowed-500-login` makes the login POST answer 500 while the UI advances to the signed-in
   * state. Every channel except the network agrees it worked.
   */
  'effect-failed-surface-advanced': {
    bug: 'swallowed-500-login',
    act: { capability: 'act', target: 'testid=login-submit', verb: 'click' },
    claim: 'the sign-in completed',
    reads: ['net'],
  },

  /** One action, two identical writes, against a claim that named one. */
  'double-submit-against-count-one': {
    bug: 'double-login',
    act: { capability: 'act', target: 'testid=login-submit', verb: 'click' },
    claim: 'exactly one sign-in request was made',
    reads: ['net'],
    // A claim that names a COUNT, written in the specification's own predicate form rather than
    // in prose. That is the whole point of this scenario: two writes landed where one was
    // claimed, and the honest route to `no` is the claim failing -- not an anomaly detector
    // happening to notice. Prose could not be evaluated, so this scenario used to come back
    // `unknown` from a window that held both requests.
    predicate: {
      kind: 'count',
      match: { channel: 'net', summary: 'net.request', valueContains: '/api/login' },
      op: 'exactly',
      value: 1,
    },
  },

  /**
   * The thing being watched goes away before the window closes.
   *
   * `hung-login` starts a request and never finishes it, so the window closes over an operation
   * still in flight. That is a fact about the OBSERVATION and never a fault in the app -- a
   * scenario that exists because blaming the app for it is the commonest way a check becomes a
   * liar.
   */
  'subject-disappears-mid-window': {
    bug: 'hung-login',
    act: { capability: 'act', target: 'testid=login-submit', verb: 'click' },
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
    act: { capability: 'act', target: 'testid=login-submit', verb: 'click' },
    claim: 'the sign-in completed',
    reads: ['net'],
  },

  /**
   * A claim that needs a channel the implementation never said it could observe.
   *
   * The only scenario here that needs NO defect and no fixture at all: the plant is the claim.
   * `visual` is the one channel of the protocol's nine that this build does not declare at
   * connect, so a claim reading it must come back `unknown` at clause 2 -- before any evidence
   * is weighed, because "nothing was watching" and "it did not happen" produce identical empty
   * evidence and must never read alike.
   *
   * It was ABSENT on both subjects purely because nobody had written these six lines, which
   * left clause 2 undriven by the suite while three other clauses were being exercised every
   * run.
   */
  'claim-reads-an-undeclared-channel': {
    bug: undefined,
    act: { capability: 'act', target: 'testid=login-submit', verb: 'click' },
    claim: 'the screen showed the signed-in view',
    reads: ['visual'],
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
