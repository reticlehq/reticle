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

/**
 * Compare an attaching agent process against this daemon: the skew to tell THAT connection, or
 * undefined when they agree. Returned rather than queued daemon-wide, because it is true only for the
 * agent that announced it (#1136).
 */
export function agentPeerSkew(version: string | null, contract: string | null): string | undefined {
  const skew = describeSkew(
    {
      what: "the agent's MCP server",
      version: version ?? undefined,
      contract: contract ?? undefined,
      // Inverted from cli-launch: here THIS process is the daemon and the peer is the agent's
      // MCP server, so the daemon is the newer half whenever the announcing agent is behind.
      fix: daemonFix(SERVER_VERSION, version ?? undefined),
    },
    { version: SERVER_VERSION, contract: CONTRACT_FINGERPRINT },
  );
  return skew;
}
