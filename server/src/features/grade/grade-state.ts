/**
 * Grade a finished run of an app from snapshots of its stored data. Pure.
 *
 * A snapshot is the state lines of `readStateSources`, and optionally a `url` line for the page the
 * run ended on. Three snapshots go in: the reference (the app after the correct steps), again (the
 * app after the same correct steps, from the same start), and the candidate (the app after the steps
 * to grade). A line that differs between the two reference snapshots is noise and is ignored, and so
 * is a change to a cell of a row that the two references wrote differently (see `grade-noise.ts`). Any
 * other line that differs between the reference and the candidate is a difference, and the grade
 * fails. A source that could not be read makes the grade unverified, never a pass.
 *
 * A row the candidate deleted and wrote again with a new id and the same values is not a difference
 * (see `grade-renumber.ts`). The grade counts these rows.
 *
 * State lines are sorted rows, so the diff is a count of each line, not an ordered diff. That keeps
 * the cost linear in the number of rows, and a source of many thousand rows is cheap.
 */
import { z } from 'zod';
import { MSG_READ_FAILED } from '../compare/outside/state-sources.js';
import { noiseCells, withoutNoiseCells } from './grade-noise.js';
import { renumber } from './grade-renumber.js';

export const GradeVerdict = {
  PASS: 'pass',
  FAIL: 'fail',
  /** The grade proves nothing: a source could not be read, or the answer could not be checked. */
  UNVERIFIED: 'unverified',
} as const;
export type GradeVerdict = (typeof GradeVerdict)[keyof typeof GradeVerdict];

export const SnapshotSchema = z.strictObject({
  lines: z.array(z.string()),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** The line that holds the page a run ended on. */
export const URL_PREFIX = 'url';

/**
 * The page a run ended on, as one line: the origin and path without a final slash, and the query
 * values sorted by name. The fragment is removed. Text that is not a URL is kept as it is.
 */
export function urlLine(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${URL_PREFIX} ${url.trim()}`;
  }
  parsed.searchParams.sort();
  const path = parsed.pathname.replace(/\/+$/, '');
  const query = parsed.searchParams.toString();
  return `${URL_PREFIX} ${parsed.origin}${path}${'' === query ? '' : `?${query}`}`;
}

export interface StateGrade {
  verdict: GradeVerdict;
  /** Lines only the reference has, less noise. */
  removed: string[];
  /** Lines only the candidate has, less noise. */
  added: string[];
  /** Lines that differed but were ignored, because they also differed between the two references. */
  ignored: number;
  /** The reads that failed, on any snapshot. */
  unread: string[];
  /** Rows the candidate deleted and wrote again with a new id and the same values. Not differences. */
  renumbered: number;
}

const counts = (lines: readonly string[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const line of lines) {
    out.set(line, (out.get(line) ?? 0) + 1);
  }
  return out;
};

/** The lines `a` has more times than `b`, once for each extra time. */
function surplus(a: readonly string[], b: readonly string[]): string[] {
  const left = counts(b);
  const out: string[] = [];
  for (const line of a) {
    const n = left.get(line) ?? 0;
    if (n > 0) {
      left.set(line, n - 1);
    } else {
      out.push(line);
    }
  }
  return out;
}

export function gradeState(reference: Snapshot, again: Snapshot, candidate: Snapshot): StateGrade {
  const unread = [reference, again, candidate].flatMap((s) =>
    s.lines.filter((line) => line.startsWith(MSG_READ_FAILED)),
  );
  const referenceOnly = surplus(reference.lines, again.lines);
  const againOnly = surplus(again.lines, reference.lines);
  const noise = new Set([...referenceOnly, ...againOnly]);
  const all = {
    removed: surplus(reference.lines, candidate.lines),
    added: surplus(candidate.lines, reference.lines),
  };
  const removedKept = all.removed.filter((line) => !noise.has(line));
  const byCell = withoutNoiseCells(
    all.added.filter((line) => !noise.has(line)),
    noiseCells(referenceOnly, againOnly),
  );
  const { removed, added, renumbered } = renumber(
    removedKept,
    byCell.added,
    reference.lines,
    candidate.lines,
  );
  const ignored = all.removed.length + all.added.length - removedKept.length - byCell.added.length;
  let verdict: GradeVerdict = GradeVerdict.PASS;
  if (unread.length > 0) {
    verdict = GradeVerdict.UNVERIFIED;
  } else if (removed.length > 0 || added.length > 0) {
    verdict = GradeVerdict.FAIL;
  }
  return { verdict, removed, added, ignored, unread, renumbered };
}
