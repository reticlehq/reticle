/**
 * Which flows a run replays, which it refused to — and which it runs AGAIN.
 *
 * Two jobs that must stay distinguishable in the answer. SELECTION is what the caller asked for.
 * EXCLUSION is what the suite declined to run despite being asked. A run that silently returns fewer
 * flows than were selected is a run whose coverage nobody can account for — so anything held back
 * comes back NAMED, never subtracted.
 *
 * The same reasoning applies to a selection that matched nothing. Quietly passing over a typo is how
 * "all green" comes to mean "nothing ran", which is the failure this product exists to prevent
 * wearing a different hat.
 *
 * Pure: flows and a selection in, three lists out. No store, no clock, no IO.
 */

import { isQuarantined, type FlowFile } from './flow-types.js';

export interface FlowSelection {
  /** Run flows carrying ANY of these labels. A set is the union of what you named, not the overlap. */
  labels?: readonly string[];
  /** Run exactly these flows, by name. */
  names?: readonly string[];
}

export interface SelectedFlows {
  /** What will actually replay, in the order given. */
  run: FlowFile[];
  /** Held back by a justified quarantine, named so the verdict can report them. */
  quarantined: string[];
  /** Labels and names that matched nothing — a typo, or a set that no longer exists. */
  unmatched: string[];
}

export function selectFlows(flows: readonly FlowFile[], selection: FlowSelection): SelectedFlows {
  const wantedLabels = selection.labels ?? [];
  const wantedNames = selection.names ?? [];
  const asked =
    0 === wantedLabels.length && 0 === wantedNames.length
      ? [...flows]
      : flows.filter(
          (flow) =>
            wantedNames.includes(flow.name) ||
            (flow.labels ?? []).some((label) => wantedLabels.includes(label)),
        );

  // Quarantine is applied AFTER selection, so asking for a label a held flow carries cannot drag it
  // back in — and so the held one is reportable as "you asked for this and we did not run it".
  const run = asked.filter((flow) => !isQuarantined(flow));
  const quarantined = asked.filter((flow) => isQuarantined(flow)).map((flow) => flow.name);

  const unmatched = [
    ...wantedNames.filter((name) => !flows.some((flow) => flow.name === name)),
    ...wantedLabels.filter((label) => !flows.some((flow) => (flow.labels ?? []).includes(label))),
  ];

  return { run, quarantined, unmatched };
}

/** How many times a flow may be re-attempted, and on what evidence. */
export interface RetryPolicy {
  attempts: number;
  /** `flake-classified` asks the ledger first; `any` does not, and the caller owns the cost. */
  on: 'any' | 'flake-classified';
}

/** What the flake ledger knows about one flow: replays on UNCHANGED code, and how many failed. */
export interface FlakeHistory {
  runs: number;
  fails: number;
}

/**
 * Should this flow be re-attempted?
 *
 * Held back until there was a ledger to ask, because without one "retry on failure" is
 * retry-everything with extra steps: a genuinely broken flow is run three times to fail three times,
 * and the suite pays triple to learn what it already knew after the first attempt.
 *
 * The ledger answers the one question that makes retry honest — has this flow been seen to BOTH pass
 * and fail on unchanged code? A flow that has only ever failed is not flaky, it is broken, and
 * re-running it is how a suite turns a real regression into a slow one. A flow with no history has
 * not been classified at all, and guessing is the same mistake with less evidence.
 *
 * Silence is never an opt-in: no policy means no retry.
 */
export function shouldRetry(
  policy: RetryPolicy | undefined,
  history: FlakeHistory | undefined,
  attemptsSoFar: number,
): boolean {
  if (policy === undefined || attemptsSoFar + 1 >= policy.attempts) return false;
  if ('any' === policy.on) return true;
  if (history === undefined || 0 === history.runs) return false;
  // Both outcomes seen on unchanged code. Neither "never failed" nor "never passed" is flaky.
  return history.fails > 0 && history.fails < history.runs;
}
