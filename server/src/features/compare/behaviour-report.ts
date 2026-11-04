/**
 * What `reticle compare` prints and exits with.
 *
 * The text shows the verdict first, then the counts, the score when a base was given, and the top
 * differences. Each difference shows the steps that reproduce it and its `-` and `+` lines. The text
 * shows the first `TOP_DIFFERENCES` differences and the first `MAX_DIFFERENCE_LINES` lines of each,
 * and says how many it left out. `--json` gives everything.
 */
import { DifferenceKind } from './compare-diff.js';
import {
  CompareVerdict,
  type BehaviourComparison,
  type BehaviourDifference,
} from './behaviour-diff.js';

export const CompareExit = { SAME: 0, DIFFERENT: 1, INVALID: 2 } as const;
export const COMPARE_SCHEMA_VERSION = 1;
export const TOP_DIFFERENCES = 5;
export const MAX_DIFFERENCE_LINES = 12;

export interface CompareUrls {
  reference: string;
  candidate: string;
  base?: string;
}

/** Seconds spent on each part of the run. */
export interface CompareTimings {
  plan: number;
  reference: number;
  candidate: number;
  base?: number;
  again: number;
}

const INDENT = '  ';
const SCORE_DIGITS = 2;
const VERDICT_WORD: Record<CompareVerdict, string> = {
  [CompareVerdict.SAME]: 'SAME',
  [CompareVerdict.DIFFERENT]: 'DIFFERENT',
  [CompareVerdict.INVALID]: 'INVALID',
};
const EXIT: Record<CompareVerdict, number> = {
  [CompareVerdict.SAME]: CompareExit.SAME,
  [CompareVerdict.DIFFERENT]: CompareExit.DIFFERENT,
  [CompareVerdict.INVALID]: CompareExit.INVALID,
};

export const compareExitCode = (result: BehaviourComparison): number => EXIT[result.verdict];

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${1 === n ? one : many}`;

function headline(urls: CompareUrls, result: BehaviourComparison): string {
  const word = VERDICT_WORD[result.verdict];
  if (CompareVerdict.INVALID === result.verdict) {
    return `${word}: ${result.reason ?? ''}`;
  }
  if (CompareVerdict.SAME === result.verdict) {
    return `${word}: ${urls.candidate} shows what ${urls.reference} shows after every sequence.`;
  }
  return `${word}: ${urls.candidate} does not show what ${urls.reference} shows. ${plural(result.differences.length, 'difference', 'differences')}.`;
}

function timingLine(t: CompareTimings): string {
  const parts = [
    `plan ${String(t.plan)} s`,
    `reference ${String(t.reference)} s`,
    `candidate ${String(t.candidate)} s`,
    ...(t.base === undefined ? [] : [`base ${String(t.base)} s`]),
    `reference again ${String(t.again)} s`,
  ];
  return `Time: ${parts.join(', ')}.`;
}

function scoreLine(result: BehaviourComparison): string | undefined {
  const s = result.score;
  if (s === undefined) {
    return undefined;
  }
  const tail = `${String(s.matched)} of ${String(s.targets)} targets matched, ${String(s.changed)} of ${String(s.kept)} kept sequences changed.`;
  if (null === s.score) {
    return `score: none. The plan reached no page that the reference changed from the base. ${tail}`;
  }
  return `score ${s.score.toFixed(SCORE_DIGITS)}: ${tail}`;
}

function differenceLines(index: number, d: BehaviourDifference): string[] {
  const tag = d.tag === undefined ? '' : `[${d.tag}] `;
  const where = plural(d.seen, 'sequence', 'sequences');
  const out = [`${String(index + 1)}. ${tag}difference ${d.id} (seen in ${where})`];
  out.push(...d.actions.map((a, i) => `${INDENT}${INDENT}${String(i + 1)}. ${a}`));
  if (DifferenceKind.UNREACHED === d.kind) {
    out.push(
      `${INDENT}The candidate could not do this step. The reference could: ${d.failedAt ?? ''}`,
    );
  }
  const marked = [...d.removed.map((l) => `- ${l}`), ...d.added.map((l) => `+ ${l}`)];
  out.push(...marked.slice(0, MAX_DIFFERENCE_LINES).map((l) => `${INDENT}${l}`));
  if (marked.length > MAX_DIFFERENCE_LINES) {
    out.push(
      `${INDENT}... ${String(marked.length - MAX_DIFFERENCE_LINES)} more lines (--json prints all)`,
    );
  }
  return out;
}

export function compareReportLines(
  urls: CompareUrls,
  result: BehaviourComparison,
  timings?: CompareTimings,
): string[] {
  const lines = [headline(urls, result)];
  if (result.sequences > 0) {
    lines.push(
      `${plural(result.sequences, 'sequence', 'sequences')}, ${String(result.compared)} compared, ` +
        `${String(result.unstable)} not compared (the reference did them on one of its two runs only), ` +
        `${String(result.referenceFailed)} the reference could not do, ` +
        `${String(result.ignored)} lines ignored as noise.`,
    );
  }
  const score = scoreLine(result);
  if (score !== undefined) {
    lines.push(score);
  }
  if (timings !== undefined) {
    lines.push(timingLine(timings));
  }
  const shown = result.differences.slice(0, TOP_DIFFERENCES);
  for (const [i, d] of shown.entries()) {
    lines.push('', ...differenceLines(i, d));
  }
  const left = result.differences.length - shown.length;
  if (left > 0) {
    lines.push('', `${plural(left, 'more difference', 'more differences')} (--json prints all).`);
  }
  return lines;
}

/** The `--json` object: every difference and every count the text gives. */
export function compareReportJson(
  urls: CompareUrls,
  result: BehaviourComparison,
  timings?: CompareTimings,
): CompareUrls &
  BehaviourComparison & { schemaVersion: number; exitCode: number; seconds?: CompareTimings } {
  return {
    schemaVersion: COMPARE_SCHEMA_VERSION,
    ...urls,
    ...result,
    exitCode: compareExitCode(result),
    ...(timings === undefined ? {} : { seconds: timings }),
  };
}
