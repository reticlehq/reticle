/**
 * Whether the agent that ran `init` has to restart before it can use what `init` set up.
 *
 * An agent client reads its MCP server list when it STARTS and never re-reads it. So the session
 * that ran `init` has the `reticle_*` tools only if Reticle was registered before it started, and
 * nothing a running session does can add them: there is no server entry in it to reconnect. The
 * honest answer is a restart, said plainly, once `init` can tell it is needed.
 *
 * Two ways to tell. This run registered the server (it cannot be in any open session), or `init`
 * runs inside an agent and the daemon has no agent attached, which is what an agent with the tools
 * always has. Pure: the facts come in, the sentence comes out.
 */

export interface RestartFacts {
  /** `init` was spawned by a coding agent (Claude Code, Codex), not typed by a person. */
  readonly insideAgent: boolean;
  /** This run registered the MCP server, so no open session has it. */
  readonly newlyRegistered: boolean;
  /** MCP clients attached to the daemon on this port; undefined when the daemon could not be asked. */
  readonly attached: number | undefined;
}

const RESTART_NOW =
  'Restart your coding agent now: this session started before Reticle was registered with it, so ' +
  'the `reticle_*` tools are not in it, and an agent loads its tools only when it starts. ' +
  '`npx @reticlehq/server init --relaunch` prints the exact resume command for Claude Code and ' +
  'Codex. Once per machine.';

export function restartNotice(facts: RestartFacts): string | undefined {
  if (facts.newlyRegistered) return RESTART_NOW;
  return facts.insideAgent && 0 === facts.attached ? RESTART_NOW : undefined;
}

/** How many agents' MCP clients the daemon's `/status` lists, or undefined for no answer. */
export function attachedAgents(status: unknown): number | undefined {
  if ('object' !== typeof status || null === status) return undefined;
  const peers = (status as { mcpPeers?: unknown }).mcpPeers;
  return Array.isArray(peers) ? peers.length : 0;
}
