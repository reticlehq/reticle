/**
 * Every scenario an implementation is scored on.
 *
 * These are described as BEHAVIOURS TO PLANT, never as fixture code. That is what makes them
 * portable: "a write echoes a different value than was requested" means something on a phone, on a
 * server and in a browser, where "click the button with data-testid=save" means something in exactly
 * one of those places.
 *
 * Every one is drawn from a failure this project has already shipped and fixed. None of them is
 * hypothetical, and each names where it came from, so an implementer can read why it is here.
 *
 * `mustProduce` is written in the vocabulary the specification already uses -- a verdict, and
 * sometimes the reason. Where only the verdict matters, the reason is left out rather than pinned to
 * whatever this implementation happens to say.
 */

/**
 * The vocabulary, imported rather than restated.
 *
 * These were declared here, as literals that "mirror the specification". They mirrored it for
 * about a day. A suite that keeps its own copy of the thing it is scoring against will eventually
 * score an implementation as wrong for disagreeing with a stale copy -- and it will be the suite
 * that is wrong, loudly and in public, which is the worst possible place for this particular
 * mistake to surface.
 */
import { Verdict, Profile, CHANNELS_REQUIRED } from '@reticlehq/openreality';

export { Verdict, Profile, CHANNELS_REQUIRED };

/**
 * The scenarios.
 *
 * `knownFailingForUs` marks the two that this project's own implementation does not pass yet. They
 * ship in the list on purpose. A conformance suite whose author passes everything is a suite shaped
 * around its author, and publishing the gaps is the only way anybody can tell the difference.
 */
export const SCENARIOS = [
  {
    id: 'effect-failed-surface-advanced',
    profile: Profile.EFFECT,
    plant: 'A request fails, and the app moves on to a success state anyway.',
    mustProduce: { verdict: Verdict.NO, ground: 'contradicted' },
    why: 'The swallowed rejection. The screen says it worked and the wire says it did not.',
  },
  {
    id: 'write-echoes-different-value',
    profile: Profile.IN_REALM,
    plant: 'A write is accepted, and what comes back differs from what was sent.',
    mustProduce: { verdict: Verdict.NO, ground: 'contradicted' },
    why: 'A field silently dropped on the way in. The call succeeded and the data is wrong.',
  },
  {
    id: 'locator-heals-to-wrong-target',
    profile: Profile.SURFACE,
    plant: 'The thing being addressed moves, and something else matches instead.',
    mustProduce: { notVerdict: Verdict.YES },
    why: 'Presence is the weakest kind of evidence: something was there, and it was the wrong thing.',
  },
  {
    id: 'consequence-already-true',
    profile: Profile.EFFECT,
    plant: 'The thing being claimed is already true before the action happens.',
    mustProduce: { verdict: Verdict.UNKNOWN, reason: 'already_true' },
    why: 'Nothing was proved. The action may have done nothing at all and the claim still holds.',
  },
  {
    id: 'double-submit-against-count-one',
    profile: Profile.EFFECT,
    plant: 'One action produces two identical writes, where one was claimed.',
    mustProduce: { verdict: Verdict.NO },
    why: 'Twice is not once, and the second one is usually somebody charged twice.',
  },
  {
    id: 'accepted-but-not-finished',
    profile: Profile.EFFECT,
    plant: 'A write is accepted for later processing and has not finished when the window closes.',
    mustProduce: { verdict: Verdict.UNKNOWN, reason: 'outcome_pending' },
    why: 'The truth has not arrived yet. Saying either yes or no would be inventing it.',
  },
  {
    id: 'evidence-from-a-previous-edit',
    profile: Profile.IN_REALM,
    plant: 'The evidence available was produced before the change under test was made.',
    mustProduce: { verdict: Verdict.UNKNOWN },
    why: 'It is true about the old code. Reporting it as true about the new code is a false pass.',
  },
  {
    id: 'outcome-in-an-unwatched-place',
    profile: Profile.EFFECT,
    plant: 'The result appears somewhere this implementation is not watching.',
    mustProduce: { notVerdict: Verdict.YES },
    why: '"It did not happen" and "nothing was watching" are not the same, and must not read alike.',
  },
  {
    id: 'fire-and-forget',
    profile: Profile.EFFECT,
    plant: 'An action is sent whose effect nothing can observe.',
    mustProduce: { notVerdict: Verdict.YES },
    why: 'Something was sent. That is all anybody knows, and it is not a verdict.',
  },
  {
    id: 'subject-disappears-mid-window',
    profile: Profile.EFFECT,
    plant: 'The thing being watched goes away before the window closes.',
    mustProduce: { verdict: Verdict.UNKNOWN, ground: 'coverage-impeached' },
    neverProduce: Verdict.NO,
    why: 'The observer left. Blaming the app for that is the most common way a check becomes a liar.',
  },
  {
    id: 'nothing-declared',
    profile: Profile.EFFECT,
    plant: 'A clean, quiet window in which nobody claimed anything would happen.',
    mustProduce: { verdict: Verdict.NO_FAULT },
    neverProduce: Verdict.YES,
    why: 'Reporting success because nobody asked a question is how a check becomes decoration.',
  },
  {
    id: 'healthy-app-real-claim',
    profile: Profile.EFFECT,
    plant: 'Nothing wrong at all, and a real claim about a real consequence.',
    mustProduce: { verdict: Verdict.YES },
    isNegativeControl: true,
    why:
      'Mandatory. Without it an implementation that answers "I could not tell" to everything ' +
      'passes every other scenario on this list.',
  },
  {
    id: 'claim-reads-an-undeclared-channel',
    profile: Profile.EFFECT,
    plant: 'A claim that needs a channel this implementation did not declare it can observe.',
    mustProduce: { verdict: Verdict.UNKNOWN, reason: 'capability-absent' },
    knownFailingForUs: true,
    why:
      'Knowable when the connection opens, rather than after the action has been spent. The rule ' +
      'existed for a while with nothing to read: no implementation declared its channels, ' +
      'including ours, so this could not be scored against anybody. The web realm now declares ' +
      'them at HELLO and the daemon reads them at assert time, so the blocker is gone -- but the ' +
      'scenario has still not been DRIVEN end to end against a planted subject, and a rule whose ' +
      'mechanism is wired is not the same as a rule that has been observed to fire. It stays ' +
      'marked failing until something measures it, because claiming the pass first is the exact ' +
      'move this suite exists to catch.',
  },
  {
    id: 'stale-data-in-a-nested-document',
    profile: Profile.SURFACE,
    plant: 'A nested document shows data from before the change, and the outer one shows it after.',
    mustProduce: { notVerdict: Verdict.YES },
    knownFailingForUs: true,
    why:
      'The one genuine miss on our own scoreboard. It is on this list because a suite whose ' +
      'author passes everything is a suite shaped around its author.',
  },
];
