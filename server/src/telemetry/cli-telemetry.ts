/**
 * The one telemetry event a human directly causes: they typed a `reticle` command.
 *
 * Lives in its own module so `cli.ts` stays a dispatcher, and so the `_daemon` exclusion below sits
 * next to the explanation of why it exists rather than buried in a startup function.
 */
import { TelemetryActor, TelemetryEventKind } from '@reticlehq/core/telemetry';
import { DAEMON_INNER_COMMAND, PROBE_COMMANDS, knownCommand } from '@/command/cli/cli-parse.js';
import { getTelemetry } from './telemetry.js';
import { drainInstallTrace } from './install-trace.js';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the installer left its breadcrumbs. Same directory the telemetry id and opt-out live in. */
const RETICLE_STATE_DIR = process.env['RETICLE_STATE_DIR'] ?? join(homedir(), '.reticle');
import { describeCliFlags } from './argument-shape.js';
import { rememberInstallSource, resolveInstallSource } from './install-source.js';
import { installPlatformLinkTelemetry } from './platform-linked.js';
import { envAgentClient } from './agent-client.js';
import { noteRunningVersion } from '@/command/update/version-seen.js';
import { wasNudged } from '@/command/update/nudge-credit.js';
import { SERVER_VERSION } from '@/command/version/identity/server-version.js';

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
 * connection — nobody types it. Counted, it dominates an event whose whole purpose is human intent,
 * and the agent attaching is already reported by `mcp_client_connected` with strictly more detail
 * (reconnect, daemon age, client).
 *
 * `serve` is NOT excluded: nothing spawns it on a person's behalf, so typing it is a real act.
 */
const AGENT_TRANSPORT_COMMAND = 'mcp';

/** True when this command represents a person typing something. Exported for the gate. */
export function isHumanCliCommand(command: string): boolean {
  return command !== AGENT_TRANSPORT_COMMAND && command !== DAEMON_INNER_COMMAND;
}

/**
 * Who ran the command. A coding agent runs `reticle gate`, `init` and `verify` through a shell, and
 * it marks the processes it spawns (see `envAgentClient`). Without the marker it is a person.
 */
export function cliActorOf(env: NodeJS.ProcessEnv): TelemetryActor {
  return envAgentClient(env) === undefined ? TelemetryActor.HUMAN : TelemetryActor.AGENT;
}

/** Set by a probe on a new machine: the install is not reported yet. */
const INSTALL_PENDING_FILE = 'install-pending';

/**
 * True when this command reports `reticle_installed`. Exported for its test.
 *
 * A probe (`--version`, `--help`, `telemetry`) on a new machine does not report the install. It
 * leaves a pending file, and the first real command after it claims the report by deleting that
 * file. So the report reads the install source that the machine state holds by then, and a probe
 * with no marker cannot make it `unknown`. A machine with no pending file and no first run has
 * reported its install already.
 */
export function claimInstallReport(command: string, firstRun: boolean, stateDir: string): boolean {
  const pending = join(stateDir, INSTALL_PENDING_FILE);
  if (PROBE_COMMANDS.has(command)) {
    if (firstRun) {
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(pending, '');
      } catch {
        /* an unwritable home: the install is not reported, as with an ephemeral id */
      }
    }
    return false;
  }
  if (firstRun) {
    return true;
  }
  try {
    unlinkSync(pending);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send `version_changed` when this start runs a different version from the last start on this
 * machine. Every start does this, the daemon too: an upgrade through `npx @reticlehq/server@latest`
 * never runs `reticle update`, so the updater alone saw almost no version move.
 */
function reportVersionMove(): void {
  const moved = noteRunningVersion(SERVER_VERSION, RETICLE_STATE_DIR);
  if (moved === undefined) {
    return;
  }
  void getTelemetry().emit(TelemetryEventKind.VERSION_CHANGED, {
    detach: true,
    versionChange: {
      ...moved,
      ...(wasNudged(moved.to, RETICLE_STATE_DIR) ? { nudged: true } : {}),
    },
  });
}

export function reportCliRun(argv: readonly string[]): void {
  const firstArg = argv[0];
  /*
   * BEFORE the `_daemon` filter, deliberately.
   *
   * The installer's breadcrumbs have to be drained on the very next invocation whatever it is, and
   * on most machines that is the agent spawning `reticle mcp`, which starts a daemon. Draining
   * after the filter would leave the file sitting until somebody happened to run a human command —
   * which on an agent-driven machine may be never.
   *
   * Idempotent by deletion rather than by a flag: the file is gone after the first drain, so a
   * second invocation finds nothing. A flag would have to live somewhere, and somewhere is another
   * file that can disagree with this one.
   */
  // Every process that may link a project, the daemon included, reports it.
  installPlatformLinkTelemetry();
  drainInstallTrace(RETICLE_STATE_DIR);
  // Before anything reads it: a channel declared on THIS command outlives it.
  rememberInstallSource(process.env, RETICLE_STATE_DIR);
  reportVersionMove();
  if (firstArg === DAEMON_INNER_COMMAND) {
    return;
  }
  const command = knownCommand(firstArg);
  const telemetry = getTelemetry();
  // FIRST — before the human-command filter. The install happened whichever real command ran, and on
  // most machines the very first contact is the agent spawning `reticle mcp`, which that filter excludes.
  // Behind the filter this event never fires at all on an install that only ever runs `reticle mcp`.
  // `detach` so a quick command (`version`/`gate`) exits immediately instead of waiting out the POST.
  if (claimInstallReport(command, telemetry.firstRun, RETICLE_STATE_DIR)) {
    void telemetry.emit(TelemetryEventKind.RETICLE_INSTALLED, {
      detach: true,
      // WHICH published route brought this machine in. Self-declared by the channel, never inferred
      // — see install-source.ts for which of the four routes can actually carry the marker.
      installSource: resolveInstallSource(process.env, RETICLE_STATE_DIR),
    });
  }
  if (!isHumanCliCommand(command)) {
    return;
  }
  void telemetry.emit(TelemetryEventKind.CLI_COMMAND_RUN, {
    detach: true,
    // The agent's transport (`mcp`) is excluded above, but an agent also runs commands through a
    // shell. `actor` splits those from a command a person typed.
    actor: cliActorOf(process.env),
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
