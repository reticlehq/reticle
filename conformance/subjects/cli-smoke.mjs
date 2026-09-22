/**
 * The command-line subject: which scenarios a process with no screen can be put into.
 *
 * A sibling of `bench-app.mjs` and `electron-smoke.mjs`, and here for the same reason both of
 * those are: a subject map is the one place an implementation can cheat without anybody noticing,
 * so it is a file a test can read rather than a constant buried in a runner.
 *
 * What is different about this one is the SURFACE. Both existing subjects are pages. This has no
 * DOM, no request to intercept, and no screen to photograph, so it is the first real test of the
 * claim the whole protocol rests on: that the adjudicator is realm-blind, and a browser is an
 * implementation detail rather than the thing the rules were quietly written around.
 *
 * Two entries here are reachable on NO other subject, and both were published gaps rather than
 * oversights:
 *
 *   `consequence-already-true` is the one ground no run of this suite has ever reached.
 *   `coverage.test.mjs` pins it: no subject could plant it, and no implementation set
 *   `consequenceHeldBefore`. A realm that snapshots a filesystem before it acts holds the
 *   before-state inherently, and the same build run twice IS the scenario.
 *
 *   `outcome-in-an-unwatched-place` had no entry anywhere. `conformance/README.md` says so in as
 *   many words. A tool writing outside its declared roots is that scenario in one line.
 *
 * Everything absent below is absent because this subject genuinely cannot produce it, and is
 * scored `absent` rather than passed. A scenario that quietly stops being plantable and stays in
 * the denominator is how a scoreboard stays perfect while testing less every month.
 */
export const CLI_SMOKE_SUBJECT = Object.freeze({
  /**
   * The mandatory negative control. A real command, a real write, a real claim.
   *
   * Almost every scenario here asks for something OTHER than a confident yes, so an
   * implementation answering "I could not tell" to everything would satisfy nearly all of them.
   */
  'healthy-app-real-claim': {
    scenario: 'healthy',
    claim: 'the build wrote its output file',
    reads: ['x-artifact'],
  },

  /**
   * The same build, twice. The second run is the scenario.
   *
   * Nothing was added to the fixture to reach this: a build that is idempotent is a build
   * behaving correctly, and the second run of one is where the question lives.
   */
  'consequence-already-true': {
    scenario: 'already-true',
    runTwice: true,
    claim: 'the output file exists',
    about: 'state',
    reads: ['x-artifact'],
  },

  /**
   * The write really happens and this vantage point really cannot see it.
   *
   * Which is the whole distinction: "it did not happen" and "nothing was watching" produce
   * identical empty evidence and mean opposite things.
   */
  'outcome-in-an-unwatched-place': {
    scenario: 'elsewhere',
    claim: 'the build wrote its output file',
    reads: ['x-artifact'],
  },

  /** A detached child does the work after the parent has gone. Nothing can observe whether it ran. */
  'fire-and-forget': {
    scenario: 'fire-and-forget',
    claim: 'the dispatched work completed',
    reads: ['x-artifact'],
  },

  /**
   * The tool announces success and the operating system ends it.
   *
   * Entitled to convict because the kill arrives on an independent channel. This is the pairing
   * the split exit status exists for.
   */
  'effect-failed-surface-advanced': {
    scenario: 'claimed-over-failure',
    claim: 'the command completed successfully',
    reads: ['x-artifact'],
  },

  /**
   * The verifier gives up and the subject does not.
   *
   * `budgetMs` is deliberately shorter than the work, because there is no other way to produce a
   * window that ran out: asking for less time than the job takes is the scenario.
   */
  'verifier-ran-out-of-budget': {
    scenario: 'over-budget',
    budgetMs: 300,
    claim: 'the command finished its work',
    reads: ['x-artifact'],
  },

  /** The thing being watched goes away before the window closes. */
  'subject-disappears-mid-window': {
    scenario: 'subject-disappears',
    claim: 'the workspace still holds its output',
    reads: ['x-artifact'],
  },

  /** A command ran and nothing was declared to prove. */
  'nothing-declared': {
    scenario: 'no-effect',
    claim: 'nothing in particular',
    declareNothing: true,
    reads: [],
  },

  /**
   * The claim is written down after the fact, so it can be met and never proved.
   *
   * The same healthy command: what changes is WHEN the claim was recorded, which is the entire
   * difference between a check and a rationalisation and is a property of the document rather
   * than of the subject.
   */
  'claim-written-after-the-action': {
    scenario: 'healthy',
    declaredAfter: true,
    claim: 'the build wrote its output file',
    reads: ['x-artifact'],
  },
});
