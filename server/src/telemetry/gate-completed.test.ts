import { describe, expect, it } from 'vitest';
import { GateOutcome, TelemetryEventKind } from '@reticlehq/core/telemetry';
import type { TelemetryExtra } from './telemetry.js';
import { reportGateCompleted } from './cli-telemetry.js';

describe('gate_completed', () => {
  it('sends the outcome block once, detached, because the CLI exits next', () => {
    const sent: { kind: string; extra: TelemetryExtra | undefined }[] = [];
    reportGateCompleted(
      { outcome: GateOutcome.PASS, flowsChecked: 2 },
      {
        emit: (kind, extra) => {
          sent.push({ kind, extra });
          return Promise.resolve(true);
        },
      },
    );
    expect(sent).toEqual([
      {
        kind: TelemetryEventKind.GATE_COMPLETED,
        extra: { gate: { outcome: GateOutcome.PASS, flowsChecked: 2 }, detach: true },
      },
    ]);
  });

  it('never throws, because a metric never fails the gate', () => {
    expect(() =>
      reportGateCompleted(
        { outcome: GateOutcome.FAIL, flowsChecked: 1 },
        {
          emit: () => {
            throw new Error('sender broke');
          },
        },
      ),
    ).not.toThrow();
  });
});
