/**
 * Global (user-scope) MCP registration for `reticle init`. The bridge + MCP server is a single
 * process that serves every project, so it is registered ONCE at user scope — not per-project via
 * a checked-in `.mcp.json`. We shell out to the official `claude mcp add -s user` CLI rather than
 * hand-editing `~/.claude.json` (a large stateful file). When the `claude` CLI is absent we print a
 * manual instruction instead.
 *
 * The registration is intentionally PORTLESS — `npx @reticlehq/server mcp`, never `--port N`. A single
 * global entry serves every project, so baking a port into it would pin every project to one port
 * and defeat per-project isolation. Instead `reticle mcp` resolves the port at runtime from the
 * project's `.reticle.json` in its CWD (see cli-port.ts). The port belongs to the project, not the
 * global agent config.
 */

import { RETICLE_NPM_PACKAGE } from '../version/server-version.js';

// The name is a wire identity and lives in the contract; re-exported here so the registration writers
// below (and their tests) keep reading it from the module that USES it.
export { MCP_SERVER_NAME } from '@reticlehq/core';
import { MCP_SERVER_NAME } from '@reticlehq/core';

/**
 * The registered command is STILL bare `npx` on every platform, deliberately.
 *
 * Windows is 66% of Reticle's users (65 of 99 in a day of telemetry) and has NO CI, no fixture, and
 * nothing in this repo has ever run there. Switching the majority platform to a launch command
 * nobody can test — where `.cmd` also has its own spawn caveats in some hosts — risks breaking the
 * users it is meant to help. So the fallback is DOCUMENTED (see mcpManual) rather than defaulted,
 * until somebody can run it on Windows.
 */
export const NPX = 'npx';
// The `reticle` bin lives in the server package, so `npx <pkg> mcp` runs the bridge without the
// retired `core` umbrella. Sourced from the single derived identity so it can never drift.
const RETICLE_PACKAGE = RETICLE_NPM_PACKAGE;
const MCP_SUBCOMMAND = 'mcp';
const CLAUDE_CLI = 'claude';

/**
 * Args after `npx` that launch the bridge: `@reticlehq/server mcp`. Portless — the port comes from
 * the project's `.reticle.json` at runtime, so one global entry works for every project.
 *
 * DELIBERATELY UNPINNED, and the trade is worth stating. `reticle init` pins the SDK to the CLI's
 * exact version, so on release day the app can be on the new one while npx serves a cached older
 * build — a real skew, reported from the field. Pinning this entry would remove that window.
 *
 * It would also freeze the agent's MCP server at whatever version was installed the day `init` ran,
 * for as long as that entry survives — and `reticle update` upgrades the CLI, not a global agent
 * config. Reticle's biggest measured problem is fixes not reaching people (2.4.0 reached zero users
 * before its nudge existed), and a permanent pin makes that worse for every install, to close a
 * window that lasts until the next npx cache miss.
 *
 * So it stays unpinned, and the skew is handled where it actually shows up: the contract fingerprint
 * makes a real mismatch loud on the next tool result (see version-skew), and a stale entry of our own
 * shape is now repaired on re-run rather than reported "already registered" (see mcp-clients.ts).
 */
export function npxServerArgs(): string[] {
  return [RETICLE_PACKAGE, MCP_SUBCOMMAND];
}

/** The npm scope every Reticle package shares — the marker of a registration we are entitled to fix. */
const RETICLE_SCOPE = '@reticlehq/';

/**
 * Is this existing registration one WE are responsible for?
 *
 * Deliberately the SCOPE and not the server package. An entry naming any `@reticlehq/*` package is
 * ours to repair — including one naming the WRONG package, which is the case this widened for:
 * `args: ["@reticlehq/core","mcp"]` was reported from the field, where `core` has no `mcp` bin, so
 * the client showed the server errored with zero tools while `init` reported it already wired and
 * left it alone on every re-run. Every `reticle_*` tool was blocked until a human edited that file.
 *
 * An entry that names no Reticle package at all — a local build, a wrapper script — is still someone
 * else's deliberate choice and is left exactly as it is.
 *
 * @param tokens every string in the entry's command + args, in any of the client shapes.
 */
export function isReticleRegistration(tokens: readonly string[]): boolean {
  return tokens.includes(NPX) && tokens.some((t) => t.includes(RETICLE_SCOPE));
}

/** The full `npx …` invocation — the tail after `claude mcp add … --`. */
function serverInvocation(): string[] {
  return [NPX, ...npxServerArgs()];
}

interface ClaudeAddCommand {
  command: string;
  args: string[];
  /** Human-readable form of the same command, for reports and manual fallback. */
  display: string;
}

/** `claude mcp add reticle -s user -- npx @reticlehq/server mcp` — registers globally for all projects (portless). */
export function claudeAddCommand(): ClaudeAddCommand {
  const tail = serverInvocation();
  const args = [MCP_SUBCOMMAND, 'add', MCP_SERVER_NAME, '-s', 'user', '--', ...tail];
  return { command: CLAUDE_CLI, args, display: `${CLAUDE_CLI} ${args.join(' ')}` };
}

/** Probe args that tell us whether an `reticle` server already exists in any scope (exit 0 = exists). */
export function claudeExistsProbe(): { command: string; args: string[] } {
  // NO `-s`: `claude mcp get` takes no options at all, so passing one exits 1 with "unknown option
  // '-s'" — the probe answered "not registered" on EVERY machine, init then ran `claude mcp add`,
  // which exits 1 with "already exists", and a re-run reported `[⚠] step failed` plus a manual
  // command that fails the same way. A false positive from a project-scoped entry costs one skipped
  // registration; the flag cost every re-run a failed step.
  return { command: CLAUDE_CLI, args: [MCP_SUBCOMMAND, 'get', MCP_SERVER_NAME] };
}

/** Probe args for whether the `claude` CLI is installed at all. */
export function claudeAvailableProbe(): { command: string; args: string[] } {
  return { command: CLAUDE_CLI, args: ['--version'] };
}

/** Printed when the `claude` CLI isn't available — register Reticle globally once, by hand. */
export function mcpManual(): string {
  const tail = serverInvocation().join(' ');
  return `Register the Reticle MCP server ONCE, globally (so every project gets it):

  ${CLAUDE_CLI} ${MCP_SUBCOMMAND} add ${MCP_SERVER_NAME} -s user -- ${tail}

Or, for another agent, add this to its global MCP config (e.g. Cursor's ~/.cursor/mcp.json):

  "${MCP_SERVER_NAME}": { "command": "${NPX}", "args": ${JSON.stringify(serverInvocation().slice(1))} }

On Windows, if the agent cannot start Reticle because npx is blocked ("running scripts is disabled
on this system" — a PowerShell execution policy), register it through cmd instead, which that policy
does not gate:

  "${MCP_SERVER_NAME}": { "command": "cmd", "args": ${JSON.stringify(['/c', NPX, ...serverInvocation().slice(1)])} }`;
}
