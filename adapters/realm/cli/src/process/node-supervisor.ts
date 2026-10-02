import { spawn } from 'node:child_process';
import type {
  ExitStatus,
  Invocation,
  RunWatcher,
  StreamLine,
  Supervisor,
  ToolIdentity,
} from './supervisor.js';

/**
 * The `Supervisor` port, over real processes.
 *
 * Everything in this adapter that knows an operating system exists is here, which is what lets
 * `CliRealm` be exercised against a fake and lets this be exercised against real programs. The two
 * halves are hard in opposite directions: the realm's difficulty is arranging a kill or a fork,
 * and this one's difficulty IS the arranging, so faking anything here would test the fake.
 *
 * It reports what happened and never whether it worked. A process that exits 1 is not a failure as
 * far as this class is concerned; it is a process that exited 1.
 */

export interface NodeSupervisorInput {
  /** The tool's own executable. Everything else comes from the manifest's argv. */
  readonly executable: string;
  /** Where commands run, which is also half the subject's identity. */
  readonly workspaceRoot: string;
  readonly tool: ToolIdentity;
  /** Injected, never `Date.now()` inline: a window's arithmetic must be reproducible. */
  readonly now: () => number;
  /**
   * The environment to run under, when it should not be inherited wholesale.
   *
   * Absent means the parent's. Named rather than assumed because a verifier that silently hands a
   * subject its own environment is one whose results depend on who ran it.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * How long to keep watching AFTER the process ends, for an effect that outlives it.
   *
   * A tool that forks and returns has not finished when it exits: the parent is gone and a child
   * is still writing. Measured while planning this, a detached child left its artifact absent at
   * the moment the parent exited and present a second and a half later.
   *
   * Without the wait a realm sees exit 0 over an empty filesystem and reports a tool that worked
   * as one that did nothing -- and clause 3 of the adjudication order runs BEFORE the coverage
   * check, so an `observed`-tier anomaly would convict it before `still-in-flight` was ever
   * consulted.
   *
   * Defaults to none, because most commands do not fork and a wait nobody needs is a tax on every
   * verification. It is the manifest's business to know which ones do.
   */
  readonly settleMs?: number;
}

export class NodeSupervisor implements Supervisor {
  readonly #input: NodeSupervisorInput;
  readonly #seen: Invocation[] = [];
  #seq = 0;

  constructor(input: NodeSupervisorInput) {
    this.#input = input;
  }

  toolIdentity(): ToolIdentity {
    return this.#input.tool;
  }

  invocationsSince(at: number): readonly Invocation[] {
    return this.#seen.filter((i) => i.startedAt >= at);
  }

  /**
   * Run one command, and stop watching when the budget ends whether or not it did.
   *
   * The three outcomes are kept apart deliberately, because a realm above this cannot tell them
   * apart afterwards if they are merged here:
   *
   *   the process chose to end   -> an exit code, `wasSignalled: false`
   *   something else ended it    -> a signal, and NO exit code to mistake for one
   *   we stopped waiting         -> no exit status at all, and no `endedAt`
   *
   * The third is the one worth stating. Killing the process on a budget and then reporting the
   * signal WE sent would make our own impatience look like the operating system's verdict on the
   * subject. So the kill happens and the absence is what gets recorded.
   */
  run(
    command: string,
    argv: readonly string[],
    budgetMs: number,
    watcher?: RunWatcher,
  ): Promise<Invocation> {
    this.#seq += 1;
    const id = `i${String(this.#seq)}`;
    const startedAt = this.#input.now();
    return new Promise<Invocation>((resolve, reject) => {
      const child = spawn(this.#input.executable, [...argv], {
        cwd: this.#input.workspaceRoot,
        ...(this.#input.env === undefined ? {} : { env: this.#input.env }),
        // stdin is CLOSED, not inherited. A tool that reads it would otherwise block to the budget
        // on an input that never arrives, and that hang is indistinguishable from a real one.
        // Phase 4's `x-cli.stdin` opens it deliberately, for a subject that is meant to be talked to.
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // The watcher is handed each line as it is COMPLETED, not each chunk as it arrives: a
      // chunk boundary is not a line boundary, and a live view showing half a word is a view
      // somebody stops trusting.
      const stdout = new LineReader(watcher?.onStdout);
      const stderr = new LineReader(watcher?.onStderr);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));

      let settled = false;
      // Read once, here, because `finish` reports it and two call sites reach `finish`.
      const settleMs = this.#input.settleMs ?? 0;
      const finish = (
        exit: ExitStatus | undefined,
        endedAt: number | undefined,
        settledMs = 0,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const invocation: Invocation = {
          id,
          command,
          argv: [...argv],
          startedAt,
          endedAt,
          exit,
          stdout: stdout.lines(),
          stderr: stderr.lines(),
          settledMs,
        };
        this.#seen.push(invocation);
        resolve(invocation);
      };

      const timer = setTimeout(() => {
        // We give up, and we say nothing about how the subject ended, because it did not.
        child.kill('SIGKILL');
        finish(undefined, undefined);
      }, budgetMs);

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Failing to REACH the tool is not a fact about the tool. Nothing was learned about its
        // behaviour, only about our ability to start it, so this is an error rather than an
        // invocation reporting a failure.
        reject(error);
      });

      child.on('close', (code, signal) => {
        const exit = exitStatus(code, signal);
        const endedAt = this.#input.now();
        if (settleMs <= 0) {
          finish(exit, endedAt);
          return;
        }
        // `endedAt` is when the PROCESS ended, not when we stopped watching. The window closed on
        // the subject's own ending, and the extra time is ours; recording the later instant would
        // put our patience into the subject's timeline.
        clearTimeout(timer);
        setTimeout(() => finish(exit, endedAt, settleMs), settleMs);
      });
    });
  }
}

/**
 * Whether the process chose how it ended, or had it chosen for it.
 *
 * Node reports one of the two as null, which is the distinction the protocol needs and the one
 * that is lost the moment they are folded into a single number. Exported for its own test: the
 * mapping is small, and it is the piece a reader is most likely to doubt.
 */
export function exitStatus(code: number | null, signal: string | null): ExitStatus {
  if (signal !== null) {
    // No exit code, deliberately. A killed process has none, and inventing one (the shell's
    // 128+n convention, say) would file a kernel decision on the channel that carries the tool's
    // own self-report.
    return { code: undefined, signal, wasSignalled: true };
  }
  return { code: code ?? undefined, signal: undefined, wasSignalled: false };
}

/**
 * Bytes to lines, holding a partial line until its newline arrives.
 *
 * A chunk boundary is not a line boundary, so splitting each chunk on its own would report one
 * line as two whenever the pipe happened to break mid-word. The sequence is per-stream and never
 * merged across the two: stdout and stderr are independently buffered, and a timestamp taken when
 * a line is READ says nothing about when it was written.
 */
class LineReader {
  #pending = '';
  readonly #lines: StreamLine[] = [];
  readonly #onLine: ((line: string) => void) | undefined;

  constructor(onLine?: (line: string) => void) {
    this.#onLine = onLine;
  }

  push(chunk: string): void {
    const parts = (this.#pending + chunk).split('\n');
    // The last part has no newline yet: it is either an unfinished line or an empty string.
    this.#pending = parts.pop() ?? '';
    for (const text of parts) {
      this.#lines.push({ seq: this.#lines.length, text });
      this.#onLine?.(text);
    }
  }

  /** Everything seen, including a trailing line the process never terminated. */
  lines(): readonly StreamLine[] {
    if ('' !== this.#pending) {
      this.#lines.push({ seq: this.#lines.length, text: this.#pending });
      this.#pending = '';
    }
    return this.#lines;
  }
}
