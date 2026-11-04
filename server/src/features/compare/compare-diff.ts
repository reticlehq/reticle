/**
 * The differences between what two builds show, after the same actions.
 *
 * Each build gives one reading for each step of each journey: the visible lines after that step, or
 * no lines when the step could not be done. The reference is read two times. A line that differs
 * between those two runs changes with no change to the build (a clock, a random id), so it is
 * ignored at that step. A step the reference did on only one of its runs is not compared at all.
 *
 * Differences with the same lines are one difference, with one id: a renamed header shows at every
 * step after it, and a reader needs to see it once.
 *
 * A step the candidate could not do is a difference, unless the step before it in the same journey
 * already showed a difference. That difference is the cause (the button was renamed, so the click
 * on the old name found nothing), and a reader needs it once.
 */
import { createHash } from 'node:crypto';

/** One step of one journey, as one build showed it. */
export interface StepReading {
  /** The journey's position in the run. The same on every build, because every build gets one list. */
  journey: number;
  /** The step's position in its journey. */
  step: number;
  /** What was done to reach this step, in order, ending with this step's own action. */
  actions: readonly string[];
  /** The visible lines after the step. Absent when the step could not be done. */
  lines?: readonly string[];
}

export const DifferenceKind = {
  /** The step was done on both builds, and they show different lines. */
  CHANGED: 'changed',
  /** The reference did the step, and the candidate could not. */
  UNREACHED: 'unreached',
} as const;
export type DifferenceKind = (typeof DifferenceKind)[keyof typeof DifferenceKind];

export interface Difference {
  /** A hash of the difference's lines: the same lines give the same id on every run. */
  id: string;
  kind: DifferenceKind;
  /** The actions that first reached it. */
  actions: readonly string[];
  /** Lines only the reference shows. */
  removed: readonly string[];
  /** Lines only the candidate shows. */
  added: readonly string[];
  /** At how many steps this same difference was seen. */
  seen: number;
}

export interface Comparison {
  differences: Difference[];
  /** Steps both builds did, and were compared. */
  compared: number;
  /** Steps the reference did on only one of its two runs, so they were not compared. */
  unstable: number;
  /** Lines that differed but were ignored, because they also differed between the reference runs. */
  ignored: number;
}

const ID_LENGTH = 12;
const HASH = 'sha256';
const HEX = 'hex';

const idOf = (content: unknown): string =>
  createHash(HASH).update(JSON.stringify(content)).digest(HEX).slice(0, ID_LENGTH);

const keyOf = (r: { journey: number; step: number }): string =>
  `${String(r.journey)}:${String(r.step)}`;

/** One run of lines that differ between two matched lines. */
interface Hunk {
  removed: string[];
  added: string[];
}

/** The runs of lines only in `a` (removed) and only in `b` (added), from a longest common subsequence. */
function hunks(a: readonly string[], b: readonly string[]): Hunk[] {
  // ponytail: O(n*m) table; a page is tens to a few hundred lines. Use Myers if pages reach thousands.
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  const at = (i: number, j: number): number => table[i]?.[j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    for (let j = b.length - 1; j >= 0 && row !== undefined; j -= 1) {
      row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: Hunk[] = [];
  let open: Hunk = { removed: [], added: [] };
  const close = (): void => {
    if (open.removed.length > 0 || open.added.length > 0) {
      out.push(open);
      open = { removed: [], added: [] };
    }
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      close();
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      open.removed.push(a[i] ?? '');
      i += 1;
    } else {
      open.added.push(b[j] ?? '');
      j += 1;
    }
  }
  open.removed.push(...a.slice(i));
  open.added.push(...b.slice(j));
  close();
  return out;
}

/** Lines only in `a` (removed) and only in `b` (added). */
export function lineDiff(
  a: readonly string[],
  b: readonly string[],
): { removed: string[]; added: string[] } {
  const all = hunks(a, b);
  return { removed: all.flatMap((h) => h.removed), added: all.flatMap((h) => h.added) };
}

/**
 * The lines of one hunk that are not noise. A reference line that also changed between the two
 * reference runs is noise, and so is the candidate line in its place: a clock reads 10:01, 10:02 and
 * 10:03 on three runs, and none of the three is a change to the build.
 *
 * ponytail: "in its place" is by count inside the hunk, so a real change next to a clock in the same
 * hunk can be ignored with it. Align by position inside the hunk if that is seen in practice.
 */
function unmasked(hunk: Hunk, noise: ReadonlySet<string>): Hunk {
  const removed = hunk.removed.filter((line) => !noise.has(line));
  let replaced = hunk.removed.length - removed.length;
  const added = hunk.added.filter((line) => {
    if (noise.has(line)) {
      return false;
    }
    if (replaced > 0) {
      replaced -= 1;
      return false;
    }
    return true;
  });
  return { removed, added };
}

/**
 * Every difference between the candidate and the reference, in the order the reference reached it.
 * `again` is the second run of the reference, which sets what is noise.
 */
export function compareReadings(
  reference: readonly StepReading[],
  again: readonly StepReading[],
  candidate: readonly StepReading[],
): Comparison {
  const second = new Map(again.map((r) => [keyOf(r), r]));
  const theirs = new Map(candidate.map((r) => [keyOf(r), r]));
  const found = new Map<string, Difference>();
  const blocked = new Set<number>();
  /** Journeys whose last compared step showed a difference. */
  const differed = new Set<number>();
  let compared = 0;
  let unstable = 0;
  let ignored = 0;
  const note = (difference: Omit<Difference, 'id' | 'seen'>, content: unknown): void => {
    const id = idOf(content);
    const known = found.get(id);
    if (known === undefined) {
      found.set(id, { id, seen: 1, ...difference });
    } else {
      known.seen += 1;
    }
  };
  for (const ours of reference) {
    const repeat = second.get(keyOf(ours))?.lines;
    if (ours.lines === undefined || blocked.has(ours.journey)) {
      continue;
    }
    if (repeat === undefined) {
      unstable += 1;
      continue;
    }
    const got = theirs.get(keyOf(ours))?.lines;
    if (got === undefined) {
      // Only the first step: the steps after it were not tried, and that is the same one cause.
      blocked.add(ours.journey);
      if (differed.has(ours.journey)) {
        continue;
      }
      const action = ours.actions.at(-1) ?? '';
      note(
        { kind: DifferenceKind.UNREACHED, actions: ours.actions, removed: [], added: [] },
        { unreached: action },
      );
      continue;
    }
    compared += 1;
    const noise = lineDiff(ours.lines, repeat);
    const masked = new Set([...noise.removed, ...noise.added]);
    const removed: string[] = [];
    const added: string[] = [];
    for (const hunk of hunks(ours.lines, got)) {
      const kept = unmasked(hunk, masked);
      removed.push(...kept.removed);
      added.push(...kept.added);
      ignored += hunk.removed.length + hunk.added.length - kept.removed.length - kept.added.length;
    }
    if (0 === removed.length && 0 === added.length) {
      differed.delete(ours.journey);
      continue;
    }
    differed.add(ours.journey);
    note(
      { kind: DifferenceKind.CHANGED, actions: ours.actions, removed, added },
      { removed, added },
    );
  }
  return { differences: [...found.values()], compared, unstable, ignored };
}
