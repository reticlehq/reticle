/**
 * When an MCP client actually attaches.
 *
 * This is the signal that separates "Reticle is installed and the daemon is running" from "a person
 * is using it". A daemon can sit up for days with no agent ever attaching — which looks like healthy
 * adoption in `daemon_started` and is in fact an onboarding failure nobody would think to report.
 *
 * It also exposes reconnect CHURN. A client whose transport keeps dropping reattaches every few
 * minutes, and in every other metric that is indistinguishable from enthusiastic use: more sessions,
 * more connects, more activity. The `reconnect` flag is what tells those two stories apart.
 */
import { TelemetryEventKind } from '@reticlehq/core/telemetry';
import { getTelemetry } from './telemetry.js';
import { appEverConnected } from './app-instrumented.js';

let connectsSeen = 0;
/** The proxies already reported. A proxy sends one id on every connect of its process. */
const proxiesSeen = new Set<string>();
/** Set when the daemon starts, so the FIRST connect can report how long Reticle sat unused. */
let daemonStartedAt: number | undefined;

export function markDaemonStart(now: number): void {
  daemonStartedAt = now;
  connectsSeen = 0;
  proxiesSeen.clear();
}

/**
 * Report one client attaching, BY NAME. Best-effort; a metric must never affect whether a client
 * connects.
 *
 * The name is required in practice, and that is the fix rather than a restriction. `connection.client`
 * was defined and documented and never once populated: the only caller reported from
 * `transport.connect().then(...)`, which resolves when the SSE stream opens — before the client has
 * said who it is. `clientInfo` first exists at `oninitialized`, so the event carried every fact about
 * the connection except the one that makes "which agent client converts best" answerable at all.
 *
 * An unnamed call reports NOTHING. A stream that opens and never completes a handshake is a probe,
 * not a client attaching, and counting it was what put an unattributable row exactly where the name
 * belonged.
 *
 * ONCE per proxy. `attachId` is the proxy's own id, and the proxy sends the same id each time it
 * reconnects. A reconnect of a known proxy is the same agent coming back, and an event for each one
 * made this the largest event kind with no new fact in it. The proxy counts its own drops on
 * `mcp_proxy_exited`. An older proxy sends no id, so each of its connects still reports.
 */
/** `connection.client`'s wire cap. */
const MAX_CLIENT_NAME = 64;

export function reportMcpConnected(
  client?: string,
  attachId?: string,
  now: () => number = () => Date.now(),
): void {
  if (client === undefined) {
    return;
  }
  if (attachId !== undefined) {
    if (proxiesSeen.has(attachId)) {
      return;
    }
    proxiesSeen.add(attachId);
  }
  try {
    const reconnect = connectsSeen > 0;
    connectsSeen += 1;
    void getTelemetry().emit(TelemetryEventKind.MCP_CLIENT_CONNECTED, {
      connection: {
        reconnect,
        // A large value on the FIRST connect is the interesting case: Reticle was started and then
        // sat there. On a reconnect it is just how long the daemon has been up.
        daemonAgeMs: daemonStartedAt === undefined ? 0 : Math.max(0, now() - daemonStartedAt),
        // Capped at the wire limit: the client names itself, and an over-long name would fail the
        // schema and drop the whole event.
        client: client.slice(0, MAX_CLIENT_NAME),
        // WHAT THE AGENT HAD TO LOOK AT. Most clients that attach never call a tool, and that cohort
        // emits nothing at all — an agent that reads the instructions, learns nothing is wired and
        // stops has refused nothing, so `tool_refused` cannot see it either. Read off the same flag
        // `app_instrumented` sets, never a second counter, so the two halves of the funnel cannot
        // disagree about one daemon run.
        appConnected: appEverConnected(),
        // The proxy that attached. Its `mcp_connection_lost` and `mcp_proxy_exited` rows carry the
        // same id and no `sessionId`, so this row is how they join this daemon run.
        ...(attachId === undefined ? {} : { proxyId: attachId }),
      },
    });
  } catch {
    /* never let a metric interfere with a client attaching */
  }
}

/** Tests only. */
export function resetMcpConnections(): void {
  connectsSeen = 0;
  proxiesSeen.clear();
  daemonStartedAt = undefined;
}
