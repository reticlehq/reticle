/**
 * The only thing here that talks to the operating system.
 *
 * A PORT, not a class. `CliRealm` depends on this interface and never on `node:child_process`, and
 * the reason is not testability alone: a realm that could only be exercised by running real
 * programs would be exercised rarely, and the cases worth exercising -- a kill, a fork whose effect
 * lands after exit, a process that never ends -- are the ones hardest to produce on demand.
 *
 * It is also where every platform difference is allowed to live. A supervisor that drives a PTY
 * (Phase 4) or routes through a proxy (Phase 3) implements the same interface; the realm above it
 * does not learn a second shape.
 */

/** One line of output, with the order it was read on ITS OWN stream. */
export interface StreamLine {
  /**
   * Position within this stream, and deliberately not a global clock.
   *
   * stdout and stderr are two independently buffered pipes, and a timestamp taken when a line is
   * READ says nothing about when it was written. A merged ordering across the two streams would be
   * fiction that reads like data, so the sequence is per-stream and no interleaving is offered.
   */
  readonly seq: number;
  readonly text: string;
}

/**
 * How a process ended, with the two halves kept apart.
 *
 * `code` is what the tool chose. `signal` is what was imposed on it. An implementation that
 * reported one number for both would have to decide which of two provenances to lie about.
 */
export interface ExitStatus {
  /**
   * The exit code, when there was one.
   *
   * Kept beside `wasSignalled` rather than encoded into one number, because exit codes wrap:
   * `sh -c 'exit 256'` exits 0, so a large code is not always the code that was meant, and a
   * single integer cannot distinguish a wrap from a success.
   */
  readonly code: number | undefined;
  /** The signal that ended it, when something else ended it. */
  readonly signal: string | undefined;
  /** Whether the ending was imposed from outside. Decides `terminated` versus `exit`. */
  readonly wasSignalled: boolean;
}

/** One run of one command, as this vantage point saw it. */
export interface Invocation {
  readonly id: string;
  /** The manifest command's name, not its argv. */
  readonly command: string;
  readonly argv: readonly string[];
  readonly startedAt: number;
  /** Absent while the process is still running. */
  readonly endedAt: number | undefined;
  /** Absent while the process is still running. */
  readonly exit: ExitStatus | undefined;
  readonly stdout: readonly StreamLine[];
  readonly stderr: readonly StreamLine[];
}

/** Who the tool is, and which workspace it is pointed at. Half of it each. */
export interface ToolIdentity {
  readonly id: string;
  readonly version: string;
  /** Stable for a workspace and different for a new one. A path, a git root, a hash: its choice. */
  readonly workspace: string;
  /** The build or commit, when knowable. */
  readonly revision?: string;
  /**
   * The round of source edits, reported ONLY for a tool under development.
   *
   * Omitted for a released build, and the omission is deliberate rather than lazy: `fixtureIsUsable`
   * requires an identical epoch, so an epoch that moves on every source edit makes every captured
   * fixture unusable. Absence is not zero, which the protocol already says.
   */
  readonly epoch?: number;
}

export interface Supervisor {
  /** Run one command to completion, or until the budget ends it. Reports what happened, never whether it worked. */
  run(command: string, argv: readonly string[], budgetMs: number): Promise<Invocation>;
  /** Everything this supervisor has seen since a moment on its own clock. */
  invocationsSince(at: number): readonly Invocation[];
  toolIdentity(): ToolIdentity;
}
