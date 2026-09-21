/**
 * Reporting that the agent lost its Reticle tools.
 *
 * The proxy already writes a full account of an outage to ~/.reticle/mcp-proxy.log, which is exactly
 * where nobody looks and nothing aggregates. So the one question the transport must answer — how
 * often does a real user's MCP server go down, and does it come back — had no answer outside the
 * machine it happened on.
 *
 * Capped at one benign and one fault event PER STAGE per proxy process, and the cap is the design
 * rather than a limitation. One
 * measured afternoon produced 547 proxy reconnects; an event per reconnect would bill for the
 * pathology instead of measuring it, which is the same mistake the per-call `tool` event made before
 * it was removed. What a dashboard needs is the SHARE OF SESSIONS that lose MCP at all (the first
 * outage) and the share where it never came back on its own (the budget being spent).
 */

import { OutageReason, OutageStage, TelemetryEventKind } from '@reticlehq/core/telemetry';
import { getTelemetry } from '@/telemetry/telemetry.js';

/**
 * `OutageStage` and `OutageReason` are core's — this re-export only saves the proxy an import. They
 * cross the wire, so the vocabulary lives in the contract package and is never re-listed here.
 */
export { OutageReason, OutageStage };

/**
 * The proxy's reason strings are free text: they also feed `proxyLog`, where prose is fine, and the
 * wire refuses anything unbounded. Unrecognised reports as `other` rather than being forwarded, so a
 * new drop path can appear in the proxy without an unclassified string leaving the machine.
 */
const KNOWN_REASONS: ReadonlySet<string> = new Set(Object.values(OutageReason));
function outageReason(raw: string): OutageReason {
  return KNOWN_REASONS.has(raw) ? (raw as OutageReason) : OutageReason.OTHER;
}

/**
 * The daemon retiring on schedule is not a fault, and it is by far the commonest drop.
 *
 * Kept as the CLASS rather than the reason itself, because the cap is keyed on it: one benign drop
 * and one fault per stage, not one event per reason. Keying on the reason would put the volume the
 * cap exists to prevent straight back — a flapping proxy has several reasons available to it and
 * would bill for each of them — while keying on the stage alone is what let a scheduled shutdown at
 * minute one permanently suppress a real outage at minute forty, biasing the metric toward exactly
 * the rows `daemon_shutdown` was introduced to exclude.
 */
function isBenign(reason: OutageReason): boolean {
  return OutageReason.DAEMON_SHUTDOWN === reason;
}

const reported = new Set<string>();

/** Reset between tests; a real process reports each stage at most once. */
export function resetOutageReporting(): void {
  reported.clear();
}

/**
 * Report one stage of an outage, at most once per process. Fire-and-forget on purpose: this runs on
 * the transport's recovery path, and a telemetry POST must never be the thing that delays — or
 * fails — the reconnect it is describing.
 */
export function reportMcpOutage(
  stage: OutageStage,
  facts: { reason: string; attempts: number; pendingLost?: number },
): void {
  const reason = outageReason(facts.reason);
  const slot = `${stage}:${isBenign(reason) ? 'benign' : 'fault'}`;
  if (reported.has(slot)) return;
  reported.add(slot);
  void getTelemetry().emit(TelemetryEventKind.MCP_CONNECTION_LOST, {
    outage: {
      stage,
      reason,
      attempts: facts.attempts,
      // Always sent, including zero: zero is the finding — a drop no agent could feel. See
      // McpOutageSchema.pendingLost.
      pendingLost: facts.pendingLost ?? 0,
    },
  });
}
