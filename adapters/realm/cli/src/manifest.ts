/**
 * What the tool under test can be asked to do, in its own words.
 *
 * There is no `click()` in this protocol and there is no `exec()` here, for the same reason: a
 * capability is declared in the DOMAIN's language, not the transport's. `deploy` is a capability;
 * running an arbitrary argv is a different and more dangerous thing, and conflating them is how a
 * discovery pass comes to place an order.
 *
 * The manifest is supplied by whoever knows the tool. Nothing here is inferred from `--help`,
 * because a guess about whether a command mutates is a guess that gets acted on.
 */

/** One thing the tool can be asked to do. */
export interface CliCommand {
  /** Domain language: `build`, `deploy`. Not `exec`, and not `run-argv`. */
  readonly name: string;
  /** What it does, for an actor deciding whether this is the thing it wants. */
  readonly meaning: string;
  /**
   * Whether performing this can change the world.
   *
   * Decides two different questions. A verifier that cannot tell a read from a write either
   * refuses to explore or explores destructively. And `determinism()` reads it to decide whether
   * a prefix may be re-driven at all.
   */
  readonly mutating: boolean;
  /**
   * Whether running it costs money or consumes a rate limit, even when it changes nothing.
   *
   * Not the same question as `mutating`, and the difference was measured rather than imagined: a
   * read-only query to an AI coding CLI mutates nothing and bills every time. `mutating` answers
   * *may I run this for discovery*; this answers *may I replay it*.
   */
  readonly costly?: boolean;
  /** The arguments, after the tool's own executable. */
  readonly argv: readonly string[];
  /** Parameter shape as JSON Schema, when it takes any. */
  readonly parameters?: unknown;
}

export interface CommandManifest {
  /**
   * The directory this tool operates on, and half of the subject's identity.
   *
   * A CLI's subject is the installed tool TOGETHER WITH the workspace, because that is what
   * persists across the invocations of a journey. See OVP-SUBJ-3.
   */
  readonly workspaceRoot: string;
  readonly commands: readonly CliCommand[];
}

/** The command by that name, or undefined. Named so no caller re-writes the lookup. */
export function commandNamed(manifest: CommandManifest, name: string): CliCommand | undefined {
  return manifest.commands.find((c) => c.name === name);
}
