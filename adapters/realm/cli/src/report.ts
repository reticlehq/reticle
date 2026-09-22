import { Declaration, Verdict, type BlindSpot, type Grade } from 'open-verification';
import type { Change } from './snapshot.js';
import type { ExitStatus } from './supervisor.js';

/**
 * What a person sees when an agent verifies its own work.
 *
 * The web side of this project overlays a HUD on the thing being acted upon. A command-line tool
 * acts on a filesystem, so the honest overlay is a DIFF -- and that is a better artifact than the
 * web ever had, because humans already read diffs all day and nobody has ever learned to read a
 * DOM mutation stream.
 *
 * Pure and deterministic: a record in, text out, no clock and no IO. The same drive renders the
 * same report, which is what makes it safe to attach to a build and to compare two of them.
 *
 * ## The ordering is the design
 *
 * `EXPECT` is rendered above `RUN`, always. It is the one property a transcript can never show
 * afterwards -- an expectation amended once the result is known reads exactly like an original one
 * -- so putting it first is how a reader sees that the claim was pre-registered rather than
 * back-filled.
 *
 * The exit code is printed, and printed where it is visibly NOT the thing that decided. Every
 * reader arrives believing `exit 0` means it worked, so the report shows them the thing they trust
 * and names what actually paid for the verdict beside it.
 */

/** One drive, as the thing a report is rendered from. */
export interface DriveRecord {
  /** What was declared, before the command ran. */
  readonly expectation: string;
  readonly command: string;
  readonly argv: readonly string[];
  readonly durationMs: number;
  readonly exit: ExitStatus | undefined;
  readonly changes: readonly Change[];
  readonly blindSpots: readonly Pick<BlindSpot, 'kind' | 'detail' | 'impeaching'>[];
  readonly adjudication: {
    readonly verdict: Verdict;
    readonly grade?: Grade;
    readonly ground: string;
    readonly reasons: readonly string[];
  };
  readonly declaredAt: Declaration;
  /** The channel that bought a `yes`. Absent when nothing did, which is itself worth showing. */
  readonly boughtBy: string | undefined;
  readonly workspaceRoot: string;
}

/**
 * How each verdict reads to a person.
 *
 * `unknown` is the row that matters. "I could not see" and "the tool is broken" send a reader in
 * opposite directions -- one says look again with better coverage, the other says go and fix
 * something -- so the word must not be a synonym for failure. NOT PROVED says what happened.
 */
const HEADLINE: Readonly<Record<Verdict, string>> = {
  [Verdict.YES]: 'yes',
  [Verdict.NO]: 'no — CONTRADICTED',
  [Verdict.UNKNOWN]: 'unknown — NOT PROVED',
  [Verdict.NO_FAULT]: 'no-fault — nothing was declared to prove',
};

const KIND_MARK: Readonly<Record<string, string>> = {
  written: 'A',
  deleted: 'D',
  modified: 'M',
  'mode-changed': 'X',
};

/** Paths relative to the workspace, because an absolute one is noise a reader has to skip. */
function relative(path: string, root: string): string {
  return path.startsWith(root) ? `.${path.slice(root.length)}` : path;
}

function exitText(exit: ExitStatus | undefined): string {
  if (exit === undefined) return 'still running';
  if (exit.wasSignalled) return `killed by ${String(exit.signal)}`;
  return `exit ${String(exit.code)}`;
}

export function renderReport(record: DriveRecord): string {
  const lines: string[] = [];

  // Always first, and never conditional on the outcome.
  lines.push(`  EXPECT   ${record.expectation}`);
  if (record.declaredAt !== Declaration.BEFORE_ACTION) {
    lines.push('           ↑ declared after the action, so it can be met and never proved');
  }

  const seconds = (record.durationMs / 1000).toFixed(1);
  lines.push(
    `  RUN      ${record.command} ${record.argv.join(' ')}`.trimEnd() +
      `   ${seconds}s   ${exitText(record.exit)}`,
  );

  if (0 === record.changes.length) {
    lines.push('  DIFF     (nothing changed under the watched roots)');
  } else {
    for (const [index, change] of record.changes.entries()) {
      const label = 0 === index ? '  DIFF     ' : '           ';
      const mark = KIND_MARK[change.kind] ?? '?';
      lines.push(`${label}${mark} ${relative(change.path, record.workspaceRoot)}`);
    }
  }

  const gaps = record.blindSpots.map((s) => s.detail);
  if (gaps.length > 0) {
    lines.push(`  BLIND    ${gaps[0] ?? ''}`);
    for (const gap of gaps.slice(1)) lines.push(`           ${gap}`);
  }

  lines.push(`  ${'─'.repeat(68)}`);
  const bought =
    record.boughtBy === undefined
      ? ''
      : ` — bought by ${record.boughtBy}, independent, consequence grade`;
  lines.push(`  VERDICT  ${HEADLINE[record.adjudication.verdict]}${bought}`);
  const reason = record.adjudication.reasons[0];
  if (reason !== undefined) lines.push(`           ${reason}`);

  return lines.join('\n');
}
