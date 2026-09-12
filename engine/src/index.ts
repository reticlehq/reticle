/**
 * The front door: what you use if you want the rules and nothing else.
 *
 * Everything here is also reachable at its own path (`@reticlehq/engine/events/predicate.js` and so
 * on), which is what Reticle's own server does -- it takes a lot of individual pieces and would gain
 * nothing from a single door. This exists for the other kind of user: somebody who wants to ask
 * "did the thing I said would happen actually happen?" and does not want to learn the layout first.
 *
 * Example, in outline:
 *
 *   const answer = await evaluatePredicate(session, { kind: 'net', urlContains: '/api/save' }, 0);
 *   // answer.pass tells you whether a save really went out.
 */

/** Ask whether something held, once. */
export { evaluatePredicate, PredicateSchema } from './question/predicate/predicate.js';
/** Ask whether something holds, and keep watching until it does or the time runs out. */
export { waitForPredicate } from './question/predicate/predicate.js';
export type { Predicate, EvalResult, PredicateSession } from './question/predicate/predicate.js';

/** What the rules need from you, and what happens when you do not supply it. */
export type { NoteFn, KeepCallerContextFn } from './window/engine-host.js';

/** Things that disagree with each other in a window: a double submit, a stale answer, a wrong unit. */
export { findContradictions } from './disagreement/contradictions.js';
export type { Contradiction, ContradictionOptions } from './disagreement/contradictions.js';

/** Add a rule of your own to the set that looks for disagreements. */
export {
  registerContradictionFold,
  registeredContradictionFolds,
  crashedRuleNotes,
  clearCrashedRules,
} from './disagreement/contradiction-folds.js';
export type { ContradictionFold } from './disagreement/contradiction-folds.js';

/** A bounded window of what happened, which is what every rule above reads. */
export { RingBuffer } from './window/ring-buffer.js';

/** What an action provoked, summarised. */
export { buildReactionReport } from './question/reaction.js';
