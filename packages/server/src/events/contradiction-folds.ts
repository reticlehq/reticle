import type { ReticleEvent } from '@reticlehq/core';
import type { Contradiction, ContradictionOptions } from './contradictions.js';
import { log } from '../log.js';

/**
 * Rules a CONSUMER adds to the contradiction pass, without editing the ones this package ships.
 *
 * Every rule in `contradictions.ts` is a pure fold over a recording — events in, findings out, no
 * session, no clock, no IO. A service embedding this engine wants rules of exactly that shape for
 * itself, and the only thing standing between it and one was that `findContradictions` folds over a
 * list written into its own body. Appending to that list means editing this package, which means a
 * fork, which means the consumer's rules and this package's rules become one tree to merge forever.
 *
 * A registry rather than a parameter on `findContradictions`, deliberately. There are six call sites
 * and a consumer reaches none of them: the tools call the pass internally, and a tool handler is
 * handed a deps bag, not options. Threading a parameter would mean touching every path a verdict can
 * take — and would still miss the one inside `crawl`. Registration happens once, at boot, by whoever
 * composed the process.
 *
 * This is not a public plugin API and should not be documented as one. It has a single intended
 * consumer, which is a service we own, and its shape is free to change in lockstep with it.
 */

/**
 * One consumer rule.
 *
 * Receives the app's OWN events — dev-tooling traffic is already removed, exactly as it is for the
 * shipped rules. A second answer to "which events count" would be a second product.
 */
export type ContradictionFold = (
  events: readonly ReticleEvent[],
  options: ContradictionOptions,
) => readonly Contradiction[];

const FOLDS: ContradictionFold[] = [];

/**
 * Add a rule to every verdict this engine produces. Returns the undo.
 *
 * The undo is not a convenience: without it a registry is process-global state that tests cannot
 * clean up, so each one starts depending on the order it ran in.
 */
export function registerContradictionFold(fold: ContradictionFold): () => void {
  FOLDS.push(fold);
  return () => {
    const at = FOLDS.indexOf(fold);
    if (at !== -1) FOLDS.splice(at, 1);
  };
}

/** What is registered right now. Exported so a guard can assert the registry is empty by default. */
export function registeredContradictionFolds(): readonly ContradictionFold[] {
  return [...FOLDS];
}

/**
 * Run every registered rule, containing anything one of them throws.
 *
 * A registered fold is somebody else's code running inside every verdict path this package has. If a
 * throw could propagate, one defect in a consumer's rule would take down `assert`, `act_and_wait`,
 * `observe` and `crawl` at once — turning a missing finding into a dead engine. Contained and logged:
 * the rules that did run still report, and the failure is visible rather than swallowed.
 */
export function runRegisteredFolds(
  events: readonly ReticleEvent[],
  options: ContradictionOptions,
): Contradiction[] {
  const found: Contradiction[] = [];
  for (const fold of FOLDS) {
    try {
      found.push(...fold(events, options));
    } catch (error) {
      log('contradiction_fold_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return found;
}
