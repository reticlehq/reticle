/**
 * How another Reticle PROCESS announces itself to the daemon.
 *
 * The SDK announces in HELLO and the CLI reads /status, but the MCP server an agent spawns had no
 * announcement at all — and it is the piece the user actually hits: `npx @reticlehq/server mcp`
 * resolves from a cache, so an agent can be running a months-old MCP package against a current
 * daemon with nothing anywhere saying so.
 *
 * It rides the SSE connect the proxy already makes, as two query params. Query params rather than a
 * new message because the connection happens before any protocol exchange, and because an older
 * proxy that sends neither is handled correctly by describeSkew (absent contract + differing version
 * = a build that predates the field).
 */
import { CONTRACT_FINGERPRINT } from '@reticlehq/core';
import { SERVER_VERSION } from './identity/server-version.js';
import { daemonFix, describeSkew } from './version-skew.js';

export const PEER_VERSION_PARAM = 'peerVersion';
export const PEER_CONTRACT_PARAM = 'peerContract';
/** The coding agent's own session id, on the same connect. */
export const AGENT_SESSION_PARAM = 'agentSession';
/**
 * Where an agent puts its session id in its MCP server's environment. Claude Code sets
 * `CLAUDE_CODE_SESSION_ID`, the same id its hooks receive as `session_id` (checked 2026-10-19).
 * Other agents set none that is documented, so their connections announce nothing.
 */
const AGENT_SESSION_ENVS = ['CLAUDE_CODE_SESSION_ID'] as const;
/** A session id is a plain token: anything else is not used as a file name. */
const PLAIN_ID = /^[\w-]{1,128}$/;

/** The agent's session id in this process's environment, when it is a plain id. */
export function agentSessionInEnv(env: NodeJS.ProcessEnv): string | undefined {
  return agentSessionOf(
    AGENT_SESSION_ENVS.map((name) => env[name]).find((v) => v !== undefined) ?? null,
  );
}

/** The query suffix that announces the agent's session, or '' when the agent named none. */
export function agentSessionQuery(env: NodeJS.ProcessEnv): string {
  const id = agentSessionInEnv(env);
  return id === undefined ? '' : `&${AGENT_SESSION_PARAM}=${encodeURIComponent(id)}`;
}

/** The announced session id, when it is a plain id. */
export function agentSessionOf(value: string | null): string | undefined {
  return null !== value && PLAIN_ID.test(value) ? value : undefined;
}

/**
 * Compare an attaching agent process against this daemon: the skew to tell THAT connection, or
 * undefined when they agree. Returned rather than queued daemon-wide, because it is true only for the
 * agent that announced it (#1136).
 */
export function agentPeerSkew(
  version: string | null,
  contract: string | null,
  pageSdkVersions: readonly (string | undefined)[] = [],
): string | undefined {
  const skew = describeSkew(
    {
      what: "the agent's MCP server",
      version: version ?? undefined,
      contract: contract ?? undefined,
      // Inverted from cli-launch: here THIS process is the daemon and the peer is the agent's
      // MCP server, so the daemon is the newer half whenever the announcing agent is behind.
      fix: daemonFix(SERVER_VERSION, version ?? undefined, pageSdkVersions),
    },
    { version: SERVER_VERSION, contract: CONTRACT_FINGERPRINT },
  );
  return skew;
}
