/**
 * Global (user-scope) MCP registration for `reticle init`. The bridge + MCP server is a single
 * process that serves every project, so it is registered ONCE at user scope — not per-project via
 * a checked-in `.mcp.json`. We shell out to the official `claude mcp add -s user` CLI rather than
 * hand-editing `~/.claude.json` (a large stateful file). When the `claude` CLI is absent we print a
 * manual instruction instead.
 *
 * The registration is intentionally PORTLESS — `npx @reticlehq/core mcp`, never `--port N`. A single
 * global entry serves every project, so baking a port into it would pin every project to one port
 * and defeat per-project isolation. Instead `reticle mcp` resolves the port at runtime from the
 * project's `.reticle.json` in its CWD (see cli-port.ts). The port belongs to the project, not the
 * global agent config.
 */

export const MCP_SERVER_NAME = 'reticle';
export const NPX = 'npx';
const RETICLE_PACKAGE = '@reticlehq/core';
const MCP_SUBCOMMAND = 'mcp';
const CLAUDE_CLI = 'claude';

/** Args after `npx` that launch the bridge: `@reticlehq/core mcp`. Portless — the port comes from
 * the project's `.reticle.json` at runtime, so one global entry works for every project. */
export function npxServerArgs(): string[] {
  return [RETICLE_PACKAGE, MCP_SUBCOMMAND];
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

/** `claude mcp add reticle -s user -- npx @reticlehq/core mcp` — registers globally for all projects (portless). */
export function claudeAddCommand(): ClaudeAddCommand {
  const tail = serverInvocation();
  const args = [MCP_SUBCOMMAND, 'add', MCP_SERVER_NAME, '-s', 'user', '--', ...tail];
  return { command: CLAUDE_CLI, args, display: `${CLAUDE_CLI} ${args.join(' ')}` };
}

/** Probe args that tell us whether an `reticle` server already exists in any scope (exit 0 = exists). */
export function claudeExistsProbe(): { command: string; args: string[] } {
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

  "${MCP_SERVER_NAME}": { "command": "${NPX}", "args": ${JSON.stringify(serverInvocation().slice(1))} }`;
}
