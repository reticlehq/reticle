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
import { getTelemetry } from '../telemetry/telemetry.js';

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
 * In the field almost every `mcp_connection_lost` event was `stage: first` with
 * `attempts: 1`** — the SSE stream ended once and the proxy reconnected. For an agent with nothing
 * in flight that is invisible. Reading 321 as "the agent lost its tools 321 times" overstates the
 * problem by nearly the whole number and buries the ONE drop that mattered (61 attempts, budget
 * spent). `pendingLost` is the part an agent can actually feel: calls answered `-32001`.
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
