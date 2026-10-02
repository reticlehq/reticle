/**
 * The metric that says whether the MCP transport is actually fixed.
 *
 * Two fixes landed for "the agent lost its tools" — the proxy no longer exits when its retry budget
 * runs out, and it no longer dies on its own uncaught exception. Neither is verifiable from here:
 * the only evidence that matters comes from real installs, and there was no event carrying it.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { OutageReason, TelemetryEventKind } from '@reticlehq/core/telemetry';
import { OutageStage, reportMcpOutage, resetOutageReporting } from './mcp-outage.js';
import { getTelemetry } from '@/telemetry/telemetry.js';

describe('reportMcpOutage', () => {
  beforeEach(() => {
    resetOutageReporting();
  });

  it('reports the first outage of a session with its cause', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.SSE_ENDED, attempts: 1 });
    expect(emit).toHaveBeenCalledWith(TelemetryEventKind.MCP_CONNECTION_LOST, {
      outage: {
        stage: OutageStage.FIRST,
        reason: OutageReason.SSE_ENDED,
        attempts: 1,
        pendingLost: 0,
      },
    });
    emit.mockRestore();
  });

  /**
   * The cap IS the design. 547 reconnects were measured in one afternoon; billing per reconnect
   * would pay for the pathology instead of measuring it — the mistake the per-call `tool` event
   * already made here once.
   */
  it('reports each stage at most once, however many times the stream drops', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    for (let i = 0; i < 50; i++) {
      reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.SSE_ENDED, attempts: i + 1 });
    }
    expect(emit).toHaveBeenCalledTimes(1);
    emit.mockRestore();
  });

  it('reports the severe stage separately — stopping retrying is a different fact', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.SSE_ENDED, attempts: 1 });
    reportMcpOutage(OutageStage.BUDGET_SPENT, { reason: OutageReason.CONNECT_ERROR, attempts: 61 });
    expect(emit).toHaveBeenCalledTimes(2);
    emit.mockRestore();
  });

  it('never awaits the POST — the transport must not wait on telemetry to reconnect', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockReturnValue(new Promise(() => undefined));
    expect(() => {
      reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.SSE_ENDED, attempts: 1 });
    }).not.toThrow();
    emit.mockRestore();
  });
});

/**
 * The proxy's drop reasons are free strings that also feed a log, and the wire takes no unbounded
 * text. `other` is the bucket that lets a new drop path exist without one leaking — a classifier
 * that cannot say "I do not know" lies instead.
 */
describe('the reason stays a closed vocabulary', () => {
  beforeEach(() => {
    resetOutageReporting();
  });

  it('forwards a reason the contract names', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    reportMcpOutage(OutageStage.FIRST, { reason: 'sse_aborted', attempts: 2 });
    expect(emit.mock.calls[0]?.[1]?.outage?.reason).toBe(OutageReason.SSE_ABORTED);
    emit.mockRestore();
  });

  it('reports anything else as `other` rather than putting it on the wire', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    reportMcpOutage(OutageStage.FIRST, { reason: 'socket hang up to 10.0.0.7', attempts: 2 });
    expect(emit.mock.calls[0]?.[1]?.outage?.reason).toBe(OutageReason.OTHER);
    emit.mockRestore();
  });
});

/**
 * An outage nobody could feel is not the same as one that killed a call.
 *
 * Almost every `mcp_connection_lost` event is `stage: first` with `attempts: 1` — the SSE stream
 * ended once and the proxy reconnected, which for an agent with nothing in flight is invisible.
 * Reading the raw count as "the agent lost its tools that many times" overstates the problem by
 * nearly the whole number and buries the drops that mattered. `pendingLost` is the part an agent can
 * actually feel: calls answered `-32001`.
 */
describe('an outage reports how many in-flight calls it actually killed', () => {
  beforeEach(() => {
    resetOutageReporting();
  });

  it('reports zero when nothing was in flight — a drop nobody noticed', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.SSE_ENDED, attempts: 1 });
    const payload = emit.mock.calls[0]?.[1] as { outage: Record<string, unknown> };
    expect(payload.outage['pendingLost'], 'zero is the finding, not an absence').toBe(0);
    emit.mockRestore();
  });

  it('reports the number of calls the drop killed', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    reportMcpOutage(OutageStage.FIRST, {
      reason: OutageReason.SSE_ABORTED,
      attempts: 2,
      pendingLost: 3,
    });
    const payload = emit.mock.calls[0]?.[1] as { outage: Record<string, unknown> };
    expect(payload.outage['pendingLost']).toBe(3);
    emit.mockRestore();
  });
});

/**
 * The cap was keyed on the STAGE alone, and the commonest drop by far is the daemon retiring on
 * schedule. So the first benign shutdown of a long-lived proxy consumed the `first` slot, and a real
 * fault later in the same process was never reported — biasing the metric toward exactly the rows
 * `daemon_shutdown` was introduced to exclude. The suppression moved from the classifier into the
 * cap and looked, from the data, like the transport getting better.
 */
describe('a benign drop cannot mask a real one', () => {
  beforeEach(() => {
    resetOutageReporting();
  });

  it('still reports a fault after the daemon retired on schedule', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.DAEMON_SHUTDOWN, attempts: 1 });
    reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.SSE_ABORTED, attempts: 4 });
    const reasons = emit.mock.calls.map(
      (call) => (call[1] as { outage: { reason: string } }).outage.reason,
    );
    expect(reasons).toEqual([OutageReason.DAEMON_SHUTDOWN, OutageReason.SSE_ABORTED]);
    emit.mockRestore();
  });

  it('still reports one of each class per stage, not one per reason', () => {
    // Keying the cap on the reason itself would put the volume back: a flapping proxy has several
    // reasons available and would bill for each of them.
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.SSE_ENDED, attempts: 1 });
    reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.SSE_ABORTED, attempts: 2 });
    reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.CONNECT_ERROR, attempts: 3 });
    expect(emit).toHaveBeenCalledTimes(1);
    emit.mockRestore();
  });

  it('reports one benign drop per stage, not one per retirement', () => {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.DAEMON_SHUTDOWN, attempts: 1 });
    reportMcpOutage(OutageStage.FIRST, { reason: OutageReason.DAEMON_SHUTDOWN, attempts: 1 });
    expect(emit).toHaveBeenCalledTimes(1);
    emit.mockRestore();
  });
});
