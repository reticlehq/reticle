/**
 * Which coding agent an event came from, as a closed value — and how the running `reticle` was
 * launched. Both are envelope fields, read per event (the client) or once per process (the launch).
 *
 * The client is the MCP handshake's `clientInfo.name` for the call in flight (or the only agent
 * attached), normalised by `agentClientOf`. When no handshake has said anything — a one-shot CLI
 * command, a proxy, a client that skipped `initialize` — the agent's own marker in the environment
 * of what it spawned is the fallback. Only markers an agent sets on purpose are read.
 */
import { AgentClient, LaunchMethod } from '@reticlehq/core/telemetry';
import { agentClientOf, callingClientName } from '@/hooks/coding-agents.js';

/**
 * Environment markers a coding agent sets on the processes it spawns. A shared daemon inherits the
 * environment of whichever agent started it, so this is a fallback after the handshake, never ahead
 * of it.
 */
const ENV_MARKERS: readonly (readonly [string, AgentClient])[] = [
  ['CLAUDECODE', AgentClient.CLAUDE_CODE],
  ['CODEX_SANDBOX', AgentClient.CODEX],
  ['CODEX_MANAGED_BY_NPM', AgentClient.CODEX],
  ['CURSOR_TRACE_ID', AgentClient.CURSOR],
  ['GEMINI_CLI', AgentClient.GEMINI_CLI],
];

export function envAgentClient(env: NodeJS.ProcessEnv): AgentClient | undefined {
  return ENV_MARKERS.find(([key]) => (env[key] ?? '') !== '')?.[1];
}

/** The client for an event being built now. */
export function currentAgentClient(env: NodeJS.ProcessEnv): AgentClient | undefined {
  return agentClientOf(callingClientName()) ?? envAgentClient(env);
}

/**
 * Where a global install puts packages, by package manager. A path that matches none of these but
 * still sits in a `node_modules` is a project's own dependency.
 */
const GLOBAL_DIRS = [
  '/lib/node_modules/',
  '/npm/node_modules/',
  '/pnpm/global/',
  '/.volta/',
  '/.bun/install/global/',
  '/yarn/global/',
  '/.nvm/',
  '/.npm-global/',
];

/** How the process was launched, from the path of its entry script. Only the bucket leaves. */
export function launchMethodOf(entry: string | undefined): LaunchMethod {
  if (entry === undefined) return LaunchMethod.OTHER;
  const path = entry.replace(/\\/g, '/').toLowerCase();
  if (path.includes('/_npx/') || path.includes('/dlx-')) return LaunchMethod.NPX;
  if (GLOBAL_DIRS.some((dir) => path.includes(dir))) return LaunchMethod.GLOBAL;
  if (path.includes('/node_modules/')) return LaunchMethod.PROJECT;
  return LaunchMethod.OTHER;
}
