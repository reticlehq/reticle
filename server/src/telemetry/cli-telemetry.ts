/**
 * The one telemetry event a human directly causes: they typed a `reticle` command.
 *
 * Lives in its own module so `cli.ts` stays a dispatcher, and so the `_daemon` exclusion below sits
 * next to the explanation of why it exists rather than buried in a startup function.
 */
import { TelemetryEventKind } from '@reticlehq/core/telemetry';
import { DAEMON_INNER_COMMAND, knownCommand } from '../command/cli/cli-parse.js';
import { getTelemetry } from './telemetry.js';
import { describeCliFlags } from './argument-shape.js';
import { resolveInstallSource } from './install-source.js';

/**
 * Report that a person ran a `reticle` subcommand.
 *
 * `_daemon` is EXCLUDED, and that exclusion is the whole point of this function. `reticle mcp` and
 * `reticle serve` start the daemon by re-running this very binary, so the child re-entered the CLI
 * entry point and emitted a second event for what a person experienced as ONE action. The old
 * `invoke` metric was therefore inflated ~2x — and inflated worst on the agent-driven sessions that
 * matter most, while one-shot commands like `version` counted once. That skewed the RATIO between
 * commands, not merely the scale, which is the kind of error you cannot correct for after the fact.
 * The daemon\'s own lifecycle is already reported by `daemon_started` / `daemon_stopped`; a spawned
 * daemon is not a CLI run.
 */
/**
 * The agent's MCP transport, not a person. `reticle mcp` is what an MCP client runs to open a stdio
 * connection — nobody types it. Measured over one real day it was 475 of 561 `cli_command_run`
 * events (85%), on an event whose whole purpose is human intent, and the agent attaching is already
 * reported by `mcp_client_connected` with strictly more detail (reconnect, daemon age, client).
 *
 * `serve` is NOT excluded: nothing spawns it on a person's behalf, so typing it is a real act.
 */
const AGENT_TRANSPORT_COMMAND = 'mcp';

/** True when this command represents a person typing something. Exported for the gate. */
export function isHumanCliCommand(command: string): boolean {
  return command !== AGENT_TRANSPORT_COMMAND && command !== DAEMON_INNER_COMMAND;
}

export function reportCliRun(argv: readonly string[]): void {
  const firstArg = argv[0];
  if (firstArg === DAEMON_INNER_COMMAND) return;
  const command = knownCommand(firstArg);
  const telemetry = getTelemetry();
  // FIRST — before the human-command filter. The install happened whichever command ran, and on most
  // machines the very first contact is the agent spawning `reticle mcp`, which that filter excludes.
  // Measured over one sweep: 15 `init_completed` and ZERO `reticle_installed`, in a run that
  // installed the SDK into nine apps — the top of every funnel, missing.
  // `detach` so a quick command (`version`/`gate`) exits immediately instead of waiting out the POST.
  if (telemetry.firstRun)
    void telemetry.emit(TelemetryEventKind.RETICLE_INSTALLED, {
      detach: true,
      // WHICH published route brought this machine in. Self-declared by the channel, never inferred
      // — see install-source.ts for which of the four routes can actually carry the marker.
      installSource: resolveInstallSource(),
    });
  if (!isHumanCliCommand(command)) return;
  void telemetry.emit(TelemetryEventKind.CLI_COMMAND_RUN, {
    detach: true,
    // No `actor`: with the agent's transport excluded, this event is human BY DEFINITION. It was
    // constant `human` on all 561 events in a real day — zero information, and wrong for the 475
    // that were the agent. `actor` stays where it earns its place: verification_completed and
    // bug_found, where it splits the agent's own loop from a human/CI-triggered run.
    // A fixed, low-cardinality vocabulary WE define, so it is safe to send whole and it is the closest
    // honest read we have on intent: `verify` and `gate` mean something very different from `status`.
    // An unrecognized first arg reports as `unknown` rather than being echoed — an echo would put
    // whatever someone mistyped, including a path or a URL, straight onto the wire.
    command,
    // Which flags were PRESENT, by name only — never their values. `--http-token` alone makes that
    // rule absolute rather than case-by-case; `--drive` and `--storage-state` carry a URL and a path.
    flags: describeCliFlags(argv),
  });
}
