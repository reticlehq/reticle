/**
 * What `init` is asked for, what it is given to do it with, and what it reports back.
 *
 * A leaf. Three detectors under `detect/` name `InitIo` to declare their own parameters, and had to
 * import it out of `run.ts` — the module that calls them. The shapes are the contract between the
 * scaffolder and its host; they belong under both, not inside one of them.
 */

import type { InitHost } from './host.js';
import type { InitOutcome } from '@reticlehq/core/telemetry';

export interface InitOptions {
  /** `--capture-bodies`: write `captureNetworkBodies: true` into the app's config. Off by default (#705). */
  captureBodies?: boolean | undefined;
  cwd: string;
  port: number | undefined;
  mcp: boolean;
  dryRun: boolean;
  install: boolean;
  /**
   * Which app in a monorepo to wire, when several are found. Without it `init` refuses to guess, and
   * "re-run inside the one you want" is not an instruction a script or an agent can follow.
   */
  app?: string;
  /** Set on the recursive call after a workspace redirect, so the search happens at most once. */
  redirected?: boolean;
  /**
   * `--url`: the address the app is ALREADY served on, so init starts nothing.
   *
   * Parsed by the CLI since the flag existed and never handed to `init`, which made the
   * package-manager refusal name it as the escape hatch while being unable to see it. The value
   * itself is not read here — only whether one was given — but it is typed as the URL rather than a
   * boolean so the option means the same thing everywhere the flag does.
   */
  url?: string | undefined;
  /**
   * Where the human ran the command, carried across a workspace redirect.
   *
   * The agent rule and `/reticle` command files are read by the AGENT, whose session runs where the
   * human started it — the repo root. Writing them beside the app instead is how a repo with its app
   * at `src/admin` ended up with no `/reticle` at all (#318).
   */
  agentRoot?: string;
  /**
   * Hand the telemetry outcome back rather than emitting it here.
   *
   * `init` now stays to watch for an app to connect, and whether it saw one belongs on the SAME
   * `init_completed` event — the funnel it exists to measure would be double-counted by a second
   * emit and unjoinable as a second event kind. Only the CLI sets this; every other caller keeps
   * today's fire-and-forget behaviour, so no path loses its event by forgetting to report.
   */
  deferOutcome?: boolean;
  /**
   * Whether the caller carries on into booting the app and driving it.
   *
   * Only affects the closing hint, which otherwise tells the reader to restart their dev server and
   * drive a flow by hand — three lines before this command does both.
   */
  continuesToRuntime?: boolean;
}

export interface InitIo {
  /** Returns file content or null if it does not exist. Path is project-relative or absolute. */
  readFile(relPath: string): string | null;
  /** Writes content, creating parent directories. Path is project-relative or absolute. */
  writeFile(relPath: string, content: string): void;
  exists(relPath: string): boolean;
  /** The user's home directory (for global agent config like ~/.cursor/mcp.json). */
  homeDir(): string;
  /** Absolute path of the directory `init` is running in — the project's own root. */
  cwd(): string;
  /** Basenames present in the project root. */
  rootFiles(): readonly string[];
  /** Subdirectory names inside a project-relative directory; empty when it isn't one. */
  listDirs(relPath: string): readonly string[];
  /** File (non-directory) basenames inside a project-relative directory, including dotfiles. */
  listFiles(relPath: string): readonly string[];
  /** The same IO re-rooted at a project-relative subdirectory (used for the workspace redirect). */
  scoped(relPath: string): InitIo;
  /** Runs a subprocess to completion (inherits stdio); returns true on exit code 0. */
  exec(command: string, args: readonly string[]): boolean;
  /** Runs a subprocess quietly (no stdio) for a yes/no check; returns true on exit code 0. */
  probe(command: string, args: readonly string[]): boolean;
  /** Can this process write into the project root — see preflight.ts. */
  canWrite(): boolean;
  print(line: string): void;
  /**
   * The capabilities only the daemon has: the release version's tracer, the outcome reporter, the
   * bridge pairing token and the declared install channel. See host.ts for why they are carried
   * here rather than as a second parameter, and why none of them is optional.
   */
  host: InitHost;
}

/**
 * What a run established, for a caller that means to continue where init stopped.
 *
 * Everything here was already computed and then thrown away. That was fine while init only wrote
 * files: nobody downstream existed. A caller that goes on to boot the app needs the same answers,
 * and re-deriving them is how two parts of one command end up disagreeing about which directory
 * they are in — which is not hypothetical, because a monorepo redirect re-enters `runInit` with a
 * different cwd and the outer caller never learns that it happened.
 */
export interface InitContext {
  /** The directory actually wired, AFTER any monorepo redirect. */
  readonly appDir: string;
  readonly framework: string;
  readonly packageManager: string;
  /** The project's own dev command, when its scripts name one. Never composed. */
  readonly devCommand?: string | undefined;
  /** Set when init redirected into a workspace app, naming the one it chose. */
  readonly redirectedTo?: string | undefined;
}

export interface InitResult {
  ok: boolean;
  applied: number;
  manual: number;
  /** What this run established. Absent only where init exits before establishing anything. */
  context?: InitContext;
  /**
   * The event body this run would report, handed to the caller instead of emitted, when
   * `deferOutcome` is set. Absent on a dry run and on the exits that report for themselves.
   */
  outcome?: InitOutcome;
}
