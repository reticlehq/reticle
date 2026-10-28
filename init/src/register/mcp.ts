/**
 * Global (user-scope) MCP registration for `reticle init`. The bridge + MCP server is a single
 * process that serves every project, so it is registered ONCE at user scope — not per-project via
 * a checked-in `.mcp.json`. We shell out to the official `claude mcp add -s user` CLI rather than
 * hand-editing `~/.claude.json` (a large stateful file). When the `claude` CLI is absent we print a
 * manual instruction instead.
 *
 * The registration is intentionally PORTLESS — it never carries `--port N`. A single
 * global entry serves every project, so baking a port into it would pin every project to one port
 * and defeat per-project isolation. Instead `reticle mcp` resolves the port at runtime from the
 * project's `.reticle.json` in its CWD (see cli-port.ts). The port belongs to the project, not the
 * global agent config.
 */

import { join } from 'node:path';
import { RETICLE_NPM_PACKAGE, RETICLE_VERSION } from '@/version.js';

// The name is a wire identity and lives in the contract; re-exported here so the registration writers
// below (and their tests) keep reading it from the module that USES it.
export { MCP_SERVER_NAME } from '@reticlehq/core';
import { MCP_SERVER_NAME } from '@reticlehq/core';
import { CLAUDE_PROJECT_CONFIG } from './mcp-clients.js';

/**
 * The registered command is STILL bare `npx` on every platform, deliberately.
 *
 * Windows is the platform where this launch path matters most, and `cmd /c` is testable under
 * Windows CI. Defaulting to it is still the riskier change: `.cmd` has spawn caveats in some hosts,
 * so the fallback stays documented rather than defaulted.
 *
 * What DID change is when it is printed. `mcpManual` used to run only when the `claude` CLI was
 * absent. The reported Windows install had `claude mcp add` succeed, so the one paragraph that
 * would have unblocked zero tools never appeared. `mcpWindowsNote` is that paragraph, and init
 * prints it on every Windows run — including the ones that look like a clean registration.
 */
export const NPX = 'npx';
// The `reticle` bin lives in the server package, so `npx <pkg> mcp` runs the bridge without the
// retired `core` umbrella. Sourced from the single derived identity so it can never drift.
const RETICLE_PACKAGE = RETICLE_NPM_PACKAGE;
const MCP_SUBCOMMAND = 'mcp';
const CLAUDE_CLI = 'claude';
const CODEX_CLI = 'codex';
/** Windows `cmd /c` — the spawn that PowerShell's execution policy does not gate. */
const WINDOWS_SHELL = 'cmd';
const WINDOWS_SHELL_C = '/c';

const NODE = 'node';

/**
 * Args after `npx` that launch the bridge: `@reticlehq/server@<this version> mcp`. Portless — the
 * port comes from the project's `.reticle.json` at runtime, so one global entry works for every
 * project.
 *
 * PINNED to one exact version. With a floating `@reticlehq/server`, npx asks the registry on every
 * start. A fresh sandbox (an empty npm cache) downloaded about 131 MB before the MCP server
 * answered: 3.9 s to 5.6 s on each boot, against 0.6 s warm. With an exact version, an image that
 * ran it once uses its cache again. A re-run of `init` or `reticle setup mcp` writes the new
 * version into a stale entry of our own shape (see mcp-clients.ts), and the contract fingerprint
 * makes a real mismatch loud on the next tool result (see version-skew).
 */
export function npxServerArgs(): string[] {
  return [`${RETICLE_PACKAGE}@${RETICLE_VERSION}`, MCP_SUBCOMMAND];
}

/** `<…>/@reticlehq/server/bin/reticle.js`, with either separator. */
const LAUNCHER_TAIL = /[\\/]@reticlehq[\\/]server[\\/]bin[\\/]reticle\.js$/;
/** A copy that a runner can delete at any time: npx `_npx`, pnpm `dlx`, yarn `dlx-*`, `bunx-*`. */
const RUN_ONCE_COPY = /[\\/](?:_npx|dlx(?:-[^\\/]*)?|bunx-[^\\/]*)[\\/]/;

/** Is this string the bin of an installed `@reticlehq/server`? */
export function isReticleLauncher(token: string): boolean {
  return LAUNCHER_TAIL.test(token);
}

/**
 * The bin to register, when the CLI that runs now is an install that stays on disk: a global
 * install, or one in a project's `node_modules`. `undefined` for a run-once copy and for a source
 * checkout. Registration then uses the pinned npx command.
 */
export function installedLauncher(bin: string | undefined): string | undefined {
  if (bin === undefined || !isReticleLauncher(bin) || RUN_ONCE_COPY.test(bin)) {
    return undefined;
  }
  return bin;
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
  if (tokens.some(isReticleLauncher)) {
    return true;
  }
  return tokens.includes(NPX) && tokens.some((t) => t.includes(RETICLE_SCOPE));
}

/**
 * The command that starts the MCP server: `node <launcher> mcp` for an installed copy, else the
 * pinned npx command. `node` is a real executable on Windows too, so it needs no `cmd /c`.
 */
export function serverInvocation(launcher?: string): string[] {
  if (launcher === undefined) {
    return [NPX, ...npxServerArgs()];
  }
  return [NODE, launcher, MCP_SUBCOMMAND];
}

interface CliAddCommand {
  command: string;
  args: string[];
  /** Human-readable form of the same command, for reports and manual fallback. */
  display: string;
}

/** `claude mcp add reticle -s user -- npx @reticlehq/server mcp` — registers globally for all projects (portless). */
export function claudeAddCommand(launcher?: string): CliAddCommand {
  const tail = serverInvocation(launcher);
  const args = [MCP_SUBCOMMAND, 'add', MCP_SERVER_NAME, '-s', 'user', '--', ...tail];
  return { command: CLAUDE_CLI, args, display: `${CLAUDE_CLI} ${args.join(' ')}` };
}

/** Where Claude Code keeps its state: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
const CLAUDE_STATE_FILE = '.claude.json';

/** `mcpServers` holds a `reticle` entry. */
function reticleEntry(scope: unknown): unknown {
  if ('object' !== typeof scope || null === scope) {
    return undefined;
  }
  const servers: unknown = (scope as { mcpServers?: unknown }).mcpServers;
  if ('object' !== typeof servers || null === servers) {
    return undefined;
  }
  return (servers as Record<string, unknown>)[MCP_SERVER_NAME];
}

function parsed(source: string | null): unknown {
  if (null === source) {
    return undefined;
  }
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

/**
 * Is a `reticle` server already registered with Claude Code, in any scope this project sees?
 *
 * READ FROM CLAUDE'S OWN CONFIG, never asked of the CLI. `claude mcp get reticle` health-checks the
 * entry by LAUNCHING it — `npx @reticlehq/server mcp` in the project — which starts a daemon on
 * whatever `.reticle.json` says before `init` has rewritten it. A re-run moving the port brought the
 * old-port daemon back about two seconds after it was stopped. `claude mcp list` health-checks
 * every server the same way.
 *
 * The three scopes `claude mcp add` writes: user (`mcpServers` at the top of the state file), local
 * (`projects[<dir>].mcpServers`, keyed by absolute path) and project (`<dir>/.mcp.json`). Without a
 * project directory only user scope is looked at. An unreadable file answers "not registered",
 * which costs at worst a `claude mcp add` that reports the entry already exists.
 */
export function claudeHasReticle(
  io: { readFile(path: string): string | null; homeDir(): string },
  projectDir: string | undefined,
  configDir: string | undefined = process.env['CLAUDE_CONFIG_DIR'],
): boolean {
  return 0 < claudeReticleEntries(io, projectDir, configDir).length;
}

/** The `reticle` entries Claude Code has, in the scopes `claudeHasReticle` reads. */
export function claudeReticleEntries(
  io: { readFile(path: string): string | null; homeDir(): string },
  projectDir: string | undefined,
  configDir: string | undefined = process.env['CLAUDE_CONFIG_DIR'],
): unknown[] {
  const state = parsed(io.readFile(join(configDir ?? io.homeDir(), CLAUDE_STATE_FILE)));
  const scopes = [state];
  if (projectDir !== undefined) {
    const projects: unknown =
      'object' === typeof state && null !== state
        ? (state as { projects?: unknown }).projects
        : undefined;
    if ('object' === typeof projects && null !== projects) {
      scopes.push((projects as Record<string, unknown>)[projectDir]);
    }
    scopes.push(parsed(io.readFile(join(projectDir, CLAUDE_PROJECT_CONFIG))));
  }
  return scopes.map(reticleEntry).filter((entry) => entry !== undefined);
}

/** Probe args for whether the `claude` CLI is installed at all. */
export function claudeAvailableProbe(): { command: string; args: string[] } {
  return { command: CLAUDE_CLI, args: ['--version'] };
}

/**
 * `codex mcp add reticle -- npx @reticlehq/server mcp` — Codex keeps the entry in its own
 * `~/.codex/config.toml`, shared by the desktop app and the CLI, so one registration covers both.
 *
 * It REPLACES an existing entry of the same name and still exits 0, so callers run it only when the
 * config names no `reticle` server at all (see `codexNamesOurServer`).
 */
export function codexAddCommand(launcher?: string): CliAddCommand {
  const args = [MCP_SUBCOMMAND, 'add', MCP_SERVER_NAME, '--', ...serverInvocation(launcher)];
  return { command: CODEX_CLI, args, display: `${CODEX_CLI} ${args.join(' ')}` };
}

/** Probe args for whether the `codex` CLI is installed at all. */
export function codexAvailableProbe(): { command: string; args: string[] } {
  return { command: CODEX_CLI, args: ['--version'] };
}

/**
 * The Windows `cmd /c npx` registration. Printed on every Windows init, not only when the `claude`
 * CLI is missing — a successful `claude mcp add` of bare `npx` is exactly the failure that reported
 * as a clean install with zero tools.
 */
export function mcpWindowsNote(): string {
  return `On Windows, if the agent cannot start Reticle because npx is blocked ("running scripts is disabled
on this system" — a PowerShell execution policy), register it through cmd instead, which that policy
does not gate:

  "${MCP_SERVER_NAME}": { "command": "${WINDOWS_SHELL}", "args": ${JSON.stringify([WINDOWS_SHELL_C, NPX, ...npxServerArgs()])} }`;
}

/** Printed when the `claude` CLI isn't available — register Reticle globally once, by hand. */
/**
 * Claude Code's PROJECT-scope config, which needs no CLI on PATH.
 *
 * The remedy a reporter had to work out for themselves: inside a Claude Code VS Code extension
 * session the `claude` binary is not on PATH, so every CLI-based route is shut and `.mcp.json` in
 * the project root is the one that still works.
 */
export function claudeProjectMcpJson(launcher?: string): string {
  const [command, ...args] = serverInvocation(launcher);
  return `${CLAUDE_PROJECT_CONFIG} (project root):

  { "mcpServers": { "${MCP_SERVER_NAME}": { "command": "${command ?? NPX}", "args": ${JSON.stringify(args)} } } }`;
}

export function mcpManual(launcher?: string): string {
  const [command, ...args] = serverInvocation(launcher);
  const tail = [command, ...args].join(' ');
  return `Register the Reticle MCP server ONCE, globally (so every project gets it):

  ${CLAUDE_CLI} ${MCP_SUBCOMMAND} add ${MCP_SERVER_NAME} -s user -- ${tail}

Or, in Claude Code with no \`claude\` on PATH (a VS Code extension session), write ${claudeProjectMcpJson(launcher)}

Or, for another agent, add this to its global MCP config (e.g. Cursor's ~/.cursor/mcp.json):

  "${MCP_SERVER_NAME}": { "command": "${command ?? NPX}", "args": ${JSON.stringify(args)} }

${mcpWindowsNote()}`;
}
