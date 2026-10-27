/** The argv word that runs the daemon itself. `serve` and the MCP proxy spawn it; a person never types it. */
export const DAEMON_INNER_COMMAND = '_daemon';

/**
 * True when `commandLine` runs a Reticle daemon (#1937).
 *
 * The MCP proxy (`reticle mcp`) and every other process fail this test, so nothing that relies on
 * it can stop the agent's proxy or a stranger's process.
 */
export function isReticleDaemonCommand(commandLine: string): boolean {
  return commandLine.trim().split(/\s+/).includes(DAEMON_INNER_COMMAND);
}
