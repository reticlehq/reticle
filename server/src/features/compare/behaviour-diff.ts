/**
 * The verdict of `reticle compare`: what the candidate shows that the reference does not. Pure.
 *
 * The reference is read two times. A line that differs between those two runs is noise (a clock, a
 * random id) and is ignored in that sequence. A sequence the reference did on only one of its runs
 * is not compared. A step the candidate cannot do where the reference could is a difference.
 * Differences with the same lines are one difference, with one id and the number of sequences it
 * was seen in.
 *
 * With a base build (the app before the change), each difference also gets a tag:
 * - `regression`: base and reference show the same page, and the candidate changed it.
 * - `target-missed`: the reference changed the page, and the candidate still shows the base page.
 * - `changed`: the candidate differs from both, or the base did not show this sequence.
 * The score is targets matched / targets x (1 - kept sequences changed / kept). A target is a
 * sequence where the reference changed the base page; a kept sequence is one where it did not.
 */
import { DifferenceKind, differenceId, lineDiff, maskedDiff } from './compare-diff.js';
import type { BuildReadings, Reading } from './build-readings.js';
import type { PlanDropped } from './action-plan.js';

export const CompareVerdict = {
  SAME: 'same',
  DIFFERENT: 'different',
  /** The run proves nothing: the driver lost its session, or nothing could be compared. */
  INVALID: 'invalid',
} as const;
export type CompareVerdict = (typeof CompareVerdict)[keyof typeof CompareVerdict];

export const DifferenceTag = {
  REGRESSION: 'regression',
  TARGET_MISSED: 'target-missed',
  CHANGED: 'changed',
} as const;
export type DifferenceTag = (typeof DifferenceTag)[keyof typeof DifferenceTag];

export interface BehaviourDifference {
  /** A hash of the difference's lines: the same lines give the same id on every run. */
  id: string;
  kind: DifferenceKind;
  /** The steps that first reached it. */
  actions: string[];
  /** Lines only the reference shows. */
  removed: string[];
  /** Lines only the candidate shows. */
  added: string[];
  /** For `unreached`: the step the candidate could not do. */
  failedAt?: string;
  /** In how many sequences this same difference was seen. */
  seen: number;
  /** With a base build only. */
  tag?: DifferenceTag;
}

export interface BehaviourScore {
  /** Null when the plan reached no target: the score cannot see the change. */
  score: number | null;
  targets: number;
  matched: number;
  kept: number;
  changed: number;
}

export interface BehaviourComparison {
  verdict: CompareVerdict;
  /** Planned sequences. */
  sequences: number;
  /** Sequences both builds showed, and were compared. */
  compared: number;
  /** Sequences the reference did on only one of its two runs, so they were not compared. */
  unstable: number;
  /** Sequences the reference could not do on its first run, so they were not compared. */
  referenceFailed: number;
  /** Lines that differed but were ignored, because they also differed between the reference runs. */
  ignored: number;
  differences: BehaviourDifference[];
  score?: BehaviourScore;
  /** What the plan left out because of a cap. Absent when no plan was made. */
  planDropped?: PlanDropped;
  /** Why the run is invalid. */
  reason?: string;
}

export const MSG_NOTHING_COMPARED =
  'Nothing was compared, so nothing was proved. The reference did no sequence two times the same way. ' +
  'Make sure the reference url opens, and that its page does not change on each load.';

/** A comparison that proves nothing. */
export function invalidComparison(reason: string, sequences: number): BehaviourComparison {
  return {
    verdict: CompareVerdict.INVALID,
    sequences,
    compared: 0,
    unstable: 0,
    referenceFailed: 0,
    ignored: 0,
    differences: [],
    reason,
  };
}

type IsNoise = (line: string) => boolean;

const DIGITS = /\d+/g;
const HAS_DIGIT = /\d/;
const DIGIT_MARK = '#';
/** A line with its numbers folded: `ticker: 76` and `ticker: 77` have one shape. */
const shapeOf = (line: string): string => line.replace(DIGITS, DIGIT_MARK);

const runNoise = (ours: Reading | undefined, repeat: Reading | undefined): string[] => {
  if (ours?.lines === undefined || repeat?.lines === undefined) {
    return [];
  }
  const d = lineDiff(ours.lines, repeat.lines);
  return [...d.removed, ...d.added];
};

/**
 * The shapes of the noise lines that hold a number, over every sequence. A live counter read the
 * same on both reference runs in one sequence by chance, and was then a difference there. When the
 * reference runs showed it changing in any sequence, it is noise in all of them.
 */
function counterShapes(input: Input): IsNoise {
  const shapes = new Set<string>();
  for (const key of input.order) {
    for (const line of runNoise(input.reference.get(key), input.again.get(key))) {
      if (HAS_DIGIT.test(line)) {
        shapes.add(shapeOf(line));
      }
    }
  }
  return (line) => shapes.has(shapeOf(line));
}

/** The noise of one sequence: what its reference runs disagree on, and every counter shape. */
const noiseOf = (
  ours: Reading | undefined,
  repeat: Reading | undefined,
  counters: IsNoise,
): IsNoise => {
  const own = new Set(runNoise(ours, repeat));
  return (line) => own.has(line) || counters(line);
};

/** The visible page without its noise lines, as one string, or undefined when it was not shown. */
const masked = (reading: Reading | undefined, isNoise: IsNoise): string | undefined =>
  reading?.lines?.filter((line) => !isNoise(line)).join('\n');

interface Input {
  /** The sequence keys, in plan order. */
  order: readonly string[];
  reference: BuildReadings;
  again: BuildReadings;
  candidate: BuildReadings;
  base?: BuildReadings;
}

function tagOf(input: Input, key: string, noise: IsNoise): DifferenceTag {
  const b = masked(input.base?.get(key), noise);
  if (b === undefined) {
    return DifferenceTag.CHANGED;
  }
  if (b === masked(input.reference.get(key), noise)) {
    return DifferenceTag.REGRESSION;
  }
  return b === masked(input.candidate.get(key), noise)
    ? DifferenceTag.TARGET_MISSED
    : DifferenceTag.CHANGED;
}

function scoreOf(input: Input, base: BuildReadings, counters: IsNoise): BehaviourScore {
  let targets = 0;
  let matched = 0;
  let kept = 0;
  let changed = 0;
  for (const key of input.order) {
    const ours = input.reference.get(key);
    const repeat = input.again.get(key);
    if (ours?.lines === undefined || repeat?.lines === undefined) {
      continue;
    }
    const noise = noiseOf(ours, repeat, counters);
    const r = masked(ours, noise);
    const b = masked(base.get(key), noise);
    if (b === undefined) {
      continue;
    }
    const got = masked(input.candidate.get(key), noise);
    if (b === r) {
      kept += 1;
      changed += got === r ? 0 : 1;
    } else {
      targets += 1;
      matched += got === r ? 1 : 0;
    }
  }
  const progress = 0 === targets ? null : matched / targets;
  const score = null === progress ? null : progress * (0 === kept ? 1 : 1 - changed / kept);
  return { score, targets, matched, kept, changed };
}

export function compareBehaviour(input: Input): BehaviourComparison {
  const counters = counterShapes(input);
  const found = new Map<string, BehaviourDifference>();
  let compared = 0;
  let unstable = 0;
  let referenceFailed = 0;
  let ignored = 0;
  const note = (key: string, difference: Omit<BehaviourDifference, 'id' | 'seen'>): void => {
    const id = differenceId(
      DifferenceKind.UNREACHED === difference.kind
        ? { unreached: difference.failedAt }
        : { removed: difference.removed, added: difference.added },
    );
    const known = found.get(id);
    if (known !== undefined) {
      known.seen += 1;
      return;
    }
    const tag =
      input.base === undefined
        ? undefined
        : tagOf(input, key, noiseOf(input.reference.get(key), input.again.get(key), counters));
    found.set(id, { id, seen: 1, ...difference, ...(tag === undefined ? {} : { tag }) });
  };
  for (const key of input.order) {
    const ours = input.reference.get(key);
    if (ours?.lines === undefined) {
      referenceFailed += 1;
      continue;
    }
    const repeat = input.again.get(key)?.lines;
    if (repeat === undefined) {
      unstable += 1;
      continue;
    }
    const got = input.candidate.get(key);
    if (got?.lines === undefined) {
      const failedAt = got?.failedAt ?? ours.actions.at(-1) ?? '';
      note(key, {
        kind: DifferenceKind.UNREACHED,
        actions: ours.actions,
        removed: [],
        added: [],
        failedAt,
      });
      continue;
    }
    compared += 1;
    const diff = maskedDiff(ours.lines, repeat, got.lines, counters);
    ignored += diff.ignored;
    if (diff.removed.length > 0 || diff.added.length > 0) {
      note(key, {
        kind: DifferenceKind.CHANGED,
        actions: ours.actions,
        removed: diff.removed,
        added: diff.added,
      });
    }
  }
  const differences = [...found.values()];
  const counts = {
    sequences: input.order.length,
    compared,
    unstable,
    referenceFailed,
    ignored,
  };
  if (0 === compared && 0 === differences.length) {
    return { ...invalidComparison(MSG_NOTHING_COMPARED, input.order.length), ...counts };
  }
  return {
    verdict: 0 === differences.length ? CompareVerdict.SAME : CompareVerdict.DIFFERENT,
    ...counts,
    differences,
    ...(input.base === undefined ? {} : { score: scoreOf(input, input.base, counters) }),
  };
}
