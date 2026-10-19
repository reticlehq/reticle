import { describe, expect, it } from 'vitest';
import {
  CountBucket,
  HarnessRunOutcome,
  HarnessRunPhase,
  HarnessRunReason,
  HarnessRunSource,
  type HarnessRun,
} from '@reticlehq/core/telemetry';
import { DriveOrigin, DriveRefusedError, DriveStatus } from '@/features/harness/drive-runs.js';
import type { TelemetryExtra } from './telemetry.js';
import {
  harnessRunEnd,
  harnessRunSource,
  reportHarnessBlocked,
  reportHarnessRun,
} from './harness-run.js';

function recorder(): {
  runs: HarnessRun[];
  emit: (k: string, e?: TelemetryExtra) => Promise<boolean>;
} {
  const runs: HarnessRun[] = [];
  return {
    runs,
    emit: (_k, e) => {
      if (e?.harness !== undefined) runs.push(e.harness);
      return Promise.resolve(true);
    },
  };
}
const START = { source: HarnessRunSource.HUD, hosted: true };
const refused = (e: unknown): boolean => e instanceof DriveRefusedError;

describe('harness_run', () => {
  it('names who started it, and a saved plan as a plan', () => {
    expect(harnessRunSource(DriveOrigin.AGENT, undefined)).toBe(HarnessRunSource.AGENT);
    expect(harnessRunSource(DriveOrigin.HUD, undefined)).toBe(HarnessRunSource.HUD);
    expect(harnessRunSource(DriveOrigin.CHAT, undefined)).toBe(HarnessRunSource.DASHBOARD);
    expect(harnessRunSource(DriveOrigin.TRY, undefined)).toBe(HarnessRunSource.CLI_TRY);
    expect(harnessRunSource(DriveOrigin.CHAT, 'hp_1')).toBe(HarnessRunSource.PLAN);
  });

  it('reads the ending, the journeys and the replays off the run, as buckets', () => {
    expect(
      harnessRunEnd(DriveStatus.DONE, {
        proved: true,
        journeys: [{ by: 'replay' }, { by: 'replay' }, { by: 'model' }],
      }),
    ).toEqual({
      outcome: HarnessRunOutcome.PROVED,
      journeys: CountBucket.TWO_THREE,
      replayed: CountBucket.TWO_THREE,
    });
    expect(harnessRunEnd(DriveStatus.DONE, { proved: false }).outcome).toBe(
      HarnessRunOutcome.NOT_PROVED,
    );
    expect(harnessRunEnd(DriveStatus.STOPPED, {}).outcome).toBe(HarnessRunOutcome.STOPPED);
    expect(harnessRunEnd(DriveStatus.BROKEN, undefined).outcome).toBe(HarnessRunOutcome.FAILED);
    expect(harnessRunEnd(DriveStatus.REFUSED, undefined)).toEqual({
      outcome: HarnessRunOutcome.BLOCKED,
      journeys: CountBucket.ZERO,
      replayed: CountBucket.ZERO,
      reason: HarnessRunReason.OTHER,
    });
  });

  it('sends one started and one completed around a run, and hands back what it did', async () => {
    const t = recorder();
    const done = await reportHarnessRun(
      START,
      () => Promise.resolve({ status: DriveStatus.DONE, result: { proved: true } }),
      refused,
      t,
    );
    expect(done.status).toBe(DriveStatus.DONE);
    expect(t.runs.map((r) => r.phase)).toEqual([
      HarnessRunPhase.STARTED,
      HarnessRunPhase.COMPLETED,
    ]);
    expect(t.runs[1]).toMatchObject({ ...START, outcome: HarnessRunOutcome.PROVED });
  });

  it('reports a refusal inside the run as blocked and a throw as failed, and still throws', async () => {
    const t = recorder();
    await expect(
      reportHarnessRun(START, () => Promise.reject(new DriveRefusedError('off')), refused, t),
    ).rejects.toThrow('off');
    await expect(
      reportHarnessRun(START, () => Promise.reject(new Error('boom')), refused, t),
    ).rejects.toThrow('boom');
    expect(
      t.runs.filter((r) => HarnessRunPhase.COMPLETED === r.phase).map((r) => r.outcome),
    ).toEqual([HarnessRunOutcome.BLOCKED, HarnessRunOutcome.FAILED]);
  });

  it('counts a run the gate refused before it started', () => {
    const t = recorder();
    reportHarnessBlocked(START, HarnessRunReason.COVERAGE_GATE, t);
    expect(t.runs).toEqual([
      { phase: HarnessRunPhase.STARTED, ...START },
      {
        phase: HarnessRunPhase.COMPLETED,
        ...START,
        outcome: HarnessRunOutcome.BLOCKED,
        journeys: CountBucket.ZERO,
        replayed: CountBucket.ZERO,
        reason: HarnessRunReason.COVERAGE_GATE,
      },
    ]);
  });
});

/*
 * A blocked or failed run said nothing about WHY. Of the hosted runs that ended in the field, most
 * were blocked or failed, and neither the refusal (switched off, no credits, not linked, a locked
 * gate) nor the break was readable from telemetry, so the Harness funnel could not be fixed from data.
 */
describe('harness_run says why a run did not drive', () => {
  it('carries the reason of a run refused before it started', () => {
    const r = recorder();
    reportHarnessBlocked(START, HarnessRunReason.HARNESS_OFF, r);
    expect(r.runs.at(-1)).toMatchObject({
      outcome: HarnessRunOutcome.BLOCKED,
      reason: HarnessRunReason.HARNESS_OFF,
    });
  });

  it('carries the reason a refusal error names', async () => {
    const r = recorder();
    await expect(
      reportHarnessRun(
        START,
        () => Promise.reject(new DriveRefusedError('no credits', HarnessRunReason.NO_CREDITS)),
        refused,
        r,
      ),
    ).rejects.toThrow('no credits');
    expect(r.runs.at(-1)).toMatchObject({
      outcome: HarnessRunOutcome.BLOCKED,
      reason: HarnessRunReason.NO_CREDITS,
    });
  });

  it('names a thrown break as broken, and says nothing on a run that drove', async () => {
    const r = recorder();
    await expect(
      reportHarnessRun(START, () => Promise.reject(new Error('page closed')), refused, r),
    ).rejects.toThrow();
    expect(r.runs.at(-1)).toMatchObject({
      outcome: HarnessRunOutcome.FAILED,
      reason: HarnessRunReason.BROKEN,
    });
    expect(harnessRunEnd(DriveStatus.DONE, { proved: true }).reason).toBeUndefined();
  });
});
