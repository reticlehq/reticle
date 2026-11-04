/**
 * What `reticle verify <candidate> --against <reference>` prints, writes and exits with.
 *
 * Exit 0 only when steps were compared and no difference was found. A run that compared nothing
 * proved nothing, so it exits 1, the same as a difference.
 */
import { DifferenceKind, type Difference } from './compare-diff.js';
import type { CompareResult } from './compare-run.js';

const EXIT_SAME = 0;
const EXIT_DIFFERENT = 1;
/** The version of the `--results-json` file this writes. */
export const COMPARE_SCHEMA_VERSION = 1;

const INDENT = '  ';
const REMOVED_MARK = '- ';
const ADDED_MARK = '+ ';
const MSG_SAME = 'No difference: the candidate shows what the reference shows after every step.';
const MSG_NOTHING_COMPARED =
  'Nothing was compared, so nothing was proved. The reference did no step two times the same way. ' +
  'Make sure the reference url opens, and that its page does not change on each load.';
const MSG_UNREACHED = 'The candidate could not do the last action. The reference could.';

interface Urls {
  reference: string;
  candidate: string;
}

export function compareExit(result: CompareResult): number {
  if (result.differences.length > 0 || 0 === result.compared) {
    return EXIT_DIFFERENT;
  }
  return EXIT_SAME;
}

function differenceLines(difference: Difference): string[] {
  const where = 1 === difference.seen ? '1 step' : `${String(difference.seen)} steps`;
  const lines = [
    `difference ${difference.id} (seen at ${where})`,
    `${INDENT}after:`,
    ...difference.actions.map((action, i) => `${INDENT}${INDENT}${String(i + 1)}. ${action}`),
  ];
  if (DifferenceKind.UNREACHED === difference.kind) {
    lines.push(`${INDENT}${MSG_UNREACHED}`);
  }
  lines.push(...difference.removed.map((line) => `${INDENT}${REMOVED_MARK}${line}`));
  lines.push(...difference.added.map((line) => `${INDENT}${ADDED_MARK}${line}`));
  return lines;
}

export function compareLines(urls: Urls, result: CompareResult): string[] {
  const lines = [
    `Compared ${urls.candidate} against ${urls.reference}.`,
    `${String(result.journeys)} journeys, ${String(result.compared)} steps compared. ` +
      `${String(result.ignored)} lines ignored, because they also changed between two runs of the reference.`,
  ];
  if (result.unstable > 0) {
    lines.push(
      `${String(result.unstable)} steps were not compared: the reference did them on one of its two runs only.`,
    );
  }
  if (result.explored.budgetExhausted) {
    lines.push(
      `The explorer used its action budget. ${String(result.explored.frontier)} states it found were not explored.`,
    );
  }
  if (0 === result.compared && 0 === result.differences.length) {
    lines.push(MSG_NOTHING_COMPARED);
    return lines;
  }
  if (0 === result.differences.length) {
    lines.push(MSG_SAME);
    return lines;
  }
  lines.push(`${String(result.differences.length)} differences:`, '');
  for (const difference of result.differences) {
    lines.push(...differenceLines(difference), '');
  }
  return lines;
}

/** The `--results-json` file. Every count the text gives is here too, so nothing is dropped silently. */
export function compareJson(
  urls: Urls,
  result: CompareResult,
): Urls & CompareResult & { schemaVersion: number; identical: boolean } {
  return {
    schemaVersion: COMPARE_SCHEMA_VERSION,
    ...urls,
    identical: EXIT_SAME === compareExit(result),
    ...result,
  };
}
