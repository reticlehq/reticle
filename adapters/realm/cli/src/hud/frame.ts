import { Verdict } from 'open-verification';
import type { Change } from '../workspace/snapshot.js';
import type { ExitStatus } from '../process/supervisor.js';

/**
 * The pane a person watches while an agent verifies its own work.
 *
 * The web side overlays a HUD on the page being acted upon. A command-line tool acts on a
 * filesystem and a process, so this is the equivalent: the claim, the command, what is being
 * watched, what has landed so far, and a verdict that is honestly absent until there is one.
 *
 * PURE. State in, a frame of text out — no clock, no terminal, no IO. The caller owns the screen
 * and the ticking, which is what makes every property below testable without a terminal and what
 * keeps the renderer from becoming a second observer of the thing it is describing.
 *
 * ## Two rows that are here for the same reason
 *
 * `EXPECT` is on screen from the first frame, before anything has happened. Watching is the ONLY
 * moment a human can see that a claim was pre-registered — afterwards a transcript cannot show it,
 * because an expectation amended once the result is known reads exactly like an original one.
 *
 * `WATCHING` names the channels. "Nothing was watching" and "it did not happen" produce identical
 * silence, and this is the one place a person can tell them apart BEFORE the verdict lands.
 */

export type HudPhase = 'running' | 'done';

export interface HudState {
  readonly expectation: string;
  readonly command: string;
  readonly argv: readonly string[];
  readonly elapsedMs: number;
  readonly phase: HudPhase;
  readonly watching: readonly string[];
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly changes: readonly Change[];
  readonly dials: readonly { host: string; port: number }[];
  readonly exit: ExitStatus | undefined;
  readonly verdict: { verdict: Verdict; ground: string; boughtBy: string | undefined } | undefined;
  readonly workspaceRoot: string;
}

/** How each verdict reads. `unknown` must never look like a failure to somebody scanning. */
const HEADLINE: Readonly<Record<Verdict, string>> = {
  [Verdict.YES]: 'yes',
  [Verdict.NO]: 'no — CONTRADICTED',
  [Verdict.UNKNOWN]: 'unknown — NOT PROVED',
  [Verdict.NO_FAULT]: 'no-fault — nothing was declared',
};

const MARK: Readonly<Record<string, string>> = {
  written: '+',
  deleted: '-',
  modified: '~',
  'mode-changed': 'x',
};

/** Frames of a spinner, indexed by elapsed time so the caller need not hold a counter. */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** How many lines of each stream to keep on screen. The rest is in the artifact. */
const TAIL = 3;

const relative = (path: string, root: string): string =>
  path.startsWith(root) ? `.${path.slice(root.length)}` : path;

function exitText(exit: ExitStatus | undefined): string {
  if (exit === undefined) return '';
  if (exit.wasSignalled) return `   killed by ${String(exit.signal)}`;
  return `   exit ${String(exit.code)}`;
}

export function renderFrame(state: HudState): string {
  const seconds = (state.elapsedMs / 1000).toFixed(1);
  const spinner =
    'running' === state.phase ? (SPIN[Math.floor(state.elapsedMs / 80) % SPIN.length] ?? '⠋') : '·';
  const label = 'running' === state.phase ? 'RUNNING' : 'RAN';

  const lines: string[] = [
    ` ${spinner} ${label.padEnd(8)} ${state.command} ${state.argv.join(' ')}`.trimEnd() +
      `   ${seconds}s${exitText(state.exit)}`,
    `   EXPECT   ${state.expectation}`,
    `   WATCHING ${state.watching.join(' · ')}`,
  ];

  const tail = (rows: readonly string[]): readonly string[] => rows.slice(-TAIL);
  for (const [index, line] of tail(state.stdout).entries()) {
    lines.push(`   ${0 === index ? 'OUT     ' : '        '} ${line}`);
  }
  for (const [index, line] of tail(state.stderr).entries()) {
    lines.push(`   ${0 === index ? 'ERR     ' : '        '} ${line}`);
  }

  if (state.changes.length > 0) {
    const shown = state.changes.slice(0, 6);
    for (const [index, change] of shown.entries()) {
      const head = 0 === index ? 'FS      ' : '        ';
      lines.push(
        `   ${head} ${MARK[change.kind] ?? '?'} ${relative(change.path, state.workspaceRoot)}`,
      );
    }
    if (state.changes.length > shown.length) {
      lines.push(`            … ${String(state.changes.length - shown.length)} more`);
    }
  }

  for (const [index, dial] of state.dials.slice(0, 3).entries()) {
    lines.push(`   ${0 === index ? 'NET     ' : '        '} ${dial.host}:${String(dial.port)}`);
  }

  lines.push(`   ${'─'.repeat(64)}`);
  if (state.verdict === undefined) {
    // Never a blank where a verdict goes: a blank is read as a pass by anybody scanning.
    lines.push('   VERDICT  pending — nothing is proved until the window closes');
  } else {
    const bought =
      state.verdict.boughtBy === undefined
        ? ''
        : ` — bought by ${state.verdict.boughtBy}, independent, consequence grade`;
    lines.push(`   VERDICT  ${HEADLINE[state.verdict.verdict]}${bought}`);
    lines.push(`            ${state.verdict.ground}`);
  }
  return lines.join('\n');
}
