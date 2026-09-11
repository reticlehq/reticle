import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefusalReason, TelemetryEventKind } from '@reticlehq/core/telemetry';
import { noteToolServed, reportToolRefused, resetToolRefusals } from './tool-refused.js';
import * as telemetry from './telemetry.js';

interface Sent {
  kind: TelemetryEventKind;
  refusal?: { tool: string; reason: RefusalReason; retried: boolean };
}

function captureEmits(): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(telemetry, 'getTelemetry').mockReturnValue({
    emit: (kind, extra) => {
      sent.push({ kind, ...(extra?.refusal === undefined ? {} : { refusal: extra.refusal }) });
      return Promise.resolve(true);
    },
    enabled: true,
    firstRun: false,
  });
  return sent;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetToolRefusals();
});

describe('tool_refused', () => {
  it('reports the tool and the reason', () => {
    const sent = captureEmits();
    reportToolRefused('reticle_act', RefusalReason.NO_SESSION);
    expect(sent).toEqual([
      {
        kind: TelemetryEventKind.TOOL_REFUSED,
        refusal: { tool: 'reticle_act', reason: RefusalReason.NO_SESSION, retried: false },
      },
    ]);
  });

  /**
   * The flag lands on the RETRY. Reporting it on the first refusal would mean holding that event
   * back until a next call arrived, which loses it entirely for the agent that gives up — and that
   * agent is the whole population this event exists to describe.
   */
  it('marks the second refusal of the same tool as a retry', () => {
    const sent = captureEmits();
    reportToolRefused('reticle_act', RefusalReason.NO_SESSION);
    reportToolRefused('reticle_act', RefusalReason.NO_SESSION);
    expect(sent.map((e) => e.refusal?.retried)).toEqual([false, true]);
  });

  it('does not call a different tool a retry', () => {
    const sent = captureEmits();
    reportToolRefused('reticle_act', RefusalReason.NO_SESSION);
    reportToolRefused('reticle_query', RefusalReason.NO_SESSION);
    expect(sent.map((e) => e.refusal?.retried)).toEqual([false, false]);
  });

  /** A call that WORKED breaks the chain: the refusal after it is not a retry of anything. */
  it('does not call a refusal after a successful call a retry', () => {
    const sent = captureEmits();
    reportToolRefused('reticle_act', RefusalReason.NO_SESSION);
    noteToolServed();
    reportToolRefused('reticle_act', RefusalReason.NO_SESSION);
    expect(sent.map((e) => e.refusal?.retried)).toEqual([false, false]);
  });

  /**
   * Volume is part of this taxonomy's design and a stuck agent is the shape that produces hundreds.
   * The cap must not stop the chain from being tracked — only from being billed for.
   */
  it('stops sending past the session cap', () => {
    const sent = captureEmits();
    for (let i = 0; i < 60; i += 1) reportToolRefused('reticle_act', RefusalReason.NO_MATCH);
    expect(sent.length).toBe(50);
  });
});
