/**
 * What a flow learns from having been run.
 *
 * The assertions a user writes by hand are the ones they thought of. The defects a drive actually
 * finds are the ones the app really has — and today they are reported once and forgotten, so the
 * next replay of the same flow is exactly as blind to them as the first was. A bug can be found,
 * fixed, and silently return, and the flow that caught it the first time says nothing.
 *
 * This is the loop that closes that, and it turns on one distinction that has to be got right:
 *
 *   A contradiction observed RIGHT NOW is not an assertion.
 *
 * Asserting "this must not happen" while it IS happening makes the flow red over a defect the user
 * already knows about, and a check that is red for an accepted reason is a check they learn to
 * ignore. Asserting the opposite — "this does happen" — is worse: it pins broken behaviour as
 * expected, producing a regression test that fires when somebody FIXES the bug.
 *
 * So a finding is first remembered as an OPEN issue, and becomes a guard only at the moment a run
 * stops showing it. That moment is the only one where the fix is a fact rather than a hope. After
 * it, the defect's return is a regression — and that is the compounding: every defect this flow has
 * ever seen and survived becomes something the app can never quietly reacquire.
 */

export const GuardState = {
  /** Seen, and still happening. Remembered, deliberately not asserted. */
  OPEN: 'open',
  /** Seen, and then observed GONE. Its return is now a regression. */
  GUARDED: 'guarded',
} as const;
export type GuardState = (typeof GuardState)[keyof typeof GuardState];

export interface LearnedGuard {
  /** The contradiction kind, as the engine names it. */
  readonly kind: string;
  /** Which step of the flow it was attributed to. The same kind at two steps is two defects. */
  readonly step: number;
  readonly state: GuardState;
  /**
   * Consecutive runs that did not show this defect, while it is still open.
   *
   * Exists because one quiet run is not a fix. Driving a real flow three times, a
   * `request-never-settled` appeared in run 1 and not in run 2 — one second apart, with no code
   * changed. Promoting there would have minted a guard out of INTERMITTENCE, and every later
   * appearance of a flaky defect would then be reported as a regression: flakiness arriving dressed
   * as a code change, which is the most expensive kind of false alarm because it looks actionable.
   *
   * Reset to zero the moment the defect reappears. Consecutive, never cumulative — two quiet runs
   * with a failure between them say "intermittent", not "fixed".
   */
  readonly cleanRuns?: number | undefined;
}

export interface SeenContradiction {
  readonly kind: string;
  readonly step: number;
}

export interface LearnInput {
  /** What this flow already knows. */
  readonly guards: readonly LearnedGuard[];
  /** What this run saw. */
  readonly seen: readonly SeenContradiction[];
  /**
   * Whether the run could observe at all. Default true.
   *
   * A run that observed NOTHING is not a run that found the app clean, and promoting on it would
   * manufacture guards out of an absence of evidence — the false green, one level up. An empty
   * `seen` from a blind run and an empty `seen` from a clean run are opposite facts.
   */
  readonly observed?: boolean;
}

export interface LearnResult {
  readonly guards: LearnedGuard[];
  /** Issues that became guards in this run — the app got better here. */
  readonly promoted: string[];
  /** Guards that fired — the app got worse here. */
  readonly regressed: string[];
}

/**
 * Consecutive quiet runs before an open defect becomes a guard.
 *
 * Two, not one, for the reason recorded on `cleanRuns`. Not more than two: every extra run is a
 * real replay the user pays for, and a defect that stays away twice in a row has earned the benefit
 * of the doubt — a guard being wrong costs one investigated regression, while never promoting costs
 * every regression this mechanism exists to catch.
 */
const CLEAN_RUNS_TO_PROMOTE = 2;

const idOf = (kind: string, step: number): string => `${kind}@${String(step)}`;

export function learnFromRun(input: LearnInput): LearnResult {
  const observed = input.observed ?? true;
  const seenIds = new Set(input.seen.map((s) => idOf(s.kind, s.step)));
  const guards: LearnedGuard[] = [];
  const promoted: string[] = [];
  const regressed: string[] = [];

  for (const guard of input.guards) {
    const isSeen = seenIds.has(idOf(guard.kind, guard.step));
    if (GuardState.GUARDED === guard.state) {
      // This flow proved once that this defect was gone. Its return is the regression this whole
      // mechanism exists to catch. The guard STAYS guarded: a defect that comes back has not
      // un-learned anything, and demoting it would mean the next return goes unreported too.
      if (isSeen) regressed.push(guard.kind);
      guards.push(guard);
      continue;
    }
    // Open, and gone — but only a run that could actually look is allowed to conclude that.
    if (!isSeen && observed) {
      const clean = (guard.cleanRuns ?? 0) + 1;
      if (clean >= CLEAN_RUNS_TO_PROMOTE) {
        guards.push({ kind: guard.kind, step: guard.step, state: GuardState.GUARDED });
        promoted.push(guard.kind);
      } else {
        guards.push({ ...guard, cleanRuns: clean });
      }
      continue;
    }
    // Seen again: the streak is broken, not merely paused.
    guards.push(isSeen ? { ...guard, cleanRuns: 0 } : guard);
  }

  const known = new Set(input.guards.map((g) => idOf(g.kind, g.step)));
  for (const s of input.seen) {
    if (known.has(idOf(s.kind, s.step))) continue;
    guards.push({ kind: s.kind, step: s.step, state: GuardState.OPEN });
  }
  return { guards, promoted, regressed };
}
