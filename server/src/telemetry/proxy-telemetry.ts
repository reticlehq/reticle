/**
 * The MCP proxy's session rollup.
 *
 * POST socket failures (`ENOBUFS`, `EMFILE`, `ECONNREFUSED` before any bytes were sent) happen in
 * this process, not the daemon's. `tool_refused` never fires (the handler never ran) and
 * `mcp_connection_lost` never fires (the SSE stream is fine). Counts live on SessionMetrics here
 * and leave as one `session_progress` — an existing kind, omitted when nothing happened.
 *
 * The send is awaited. Fire-and-forget microseconds before `process.exit` is how `daemon_stopped`
 * never arrived: the POST was killed every time and nothing threw.
 */
import {
  TelemetryEventKind,
  type ProxyExitReason,
  type WakeRefusalPresence,
} from '@reticlehq/core/telemetry';
import { randomUUID } from 'node:crypto';
import { getSessionMetrics, type SessionMetrics } from './session-metrics.js';
import { getTelemetry, type Telemetry } from './telemetry.js';

export async function flushProxySessionMetrics(
  telemetry: Telemetry = getTelemetry(),
  metrics: SessionMetrics = getSessionMetrics(),
): Promise<void> {
  if (metrics.empty) return;
  await telemetry.emit(TelemetryEventKind.SESSION_PROGRESS, {
    // A window, not the final roll-up: this rides `session_progress`, which every query sums, and a
    // final summary would also resolve calls and stamp an end reason for a process that is not the
    // daemon whose session this is.
    session: metrics.summarize(false),
  });
}

/**
 * This proxy process's id. The proxy sends it to the daemon on every connect, and the daemon puts
 * it on `mcp_client_connected`. The proxy's own events carry it too, so an outage or an exit joins
 * the daemon run it served. A random UUID for each process: it names nothing on the machine.
 */
export const PROXY_ID = randomUUID();

/** What this proxy process saw in its life, for `mcp_proxy_exited`. One proxy per process. */
let drops = 0;
let toolCalls = 0;
let exitReported = false;
let wakeRefusalReported = false;

/** The proxy lost its daemon stream. */
export function noteProxyDrop(): void {
  drops += 1;
}

/** The client sent a `tools/call` through the proxy. */
export function noteProxyToolCall(): void {
  toolCalls += 1;
}

/** Reset between tests. A real process reports each of these at most once. */
export function resetProxyExitReporting(): void {
  drops = 0;
  toolCalls = 0;
  exitReported = false;
  wakeRefusalReported = false;
}

/**
 * Send `mcp_proxy_exited`, once per process. Awaited by the caller before it exits, because a send
 * that is not awaited before `process.exit` does not arrive. `emit` bounds the send with its own
 * timeout, and it never throws.
 *
 * Sent even when every count is zero: a proxy that left with nothing else to say is the case that
 * was invisible.
 */
export async function reportProxyExited(
  reason: ProxyExitReason,
  telemetry: Telemetry = getTelemetry(),
  // The process clock, read at this boundary: the proxy's uptime IS the process's.
  uptimeMs: number = Math.round(process.uptime() * 1000),
): Promise<void> {
  if (exitReported) {
    return;
  }
  exitReported = true;
  await telemetry.emit(TelemetryEventKind.MCP_PROXY_EXITED, {
    proxyExit: { reason, uptimeMs, drops, toolCalls, proxyId: PROXY_ID },
  });
}

/** Everything the proxy sends on its way out. Awaited, then the caller exits. */
export async function flushProxyExit(reason: ProxyExitReason): Promise<void> {
  await Promise.allSettled([flushProxySessionMetrics(), reportProxyExited(reason)]);
}

/** Send `daemon_died_unclean`. Fire-and-forget is fine for callers: the process lives on. */
export async function reportDaemonDiedUnclean(
  ageMs: number,
  telemetry: Telemetry = getTelemetry(),
): Promise<void> {
  await telemetry.emit(TelemetryEventKind.DAEMON_DIED_UNCLEAN, {
    daemonDeath: { ageMs: Math.max(0, Math.round(ageMs)) },
  });
}

/**
 * Send `wake_refused`, once per process. A dormant proxy refuses again on every client request, and
 * one event per request would count the client's retries, not the refusal.
 */
export async function reportWakeRefused(
  presence: WakeRefusalPresence,
  telemetry: Telemetry = getTelemetry(),
): Promise<void> {
  if (wakeRefusalReported) {
    return;
  }
  wakeRefusalReported = true;
  await telemetry.emit(TelemetryEventKind.WAKE_REFUSED, {
    wakeRefusal: { presence },
  });
}
