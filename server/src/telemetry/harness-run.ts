/**
 * `harness_run`: the Harness funnel. One `started` and one `completed` per run, whoever started it.
 *
 * Emitted around the drive itself (`startDrive`'s run), not read off the tool answer: a drive started
 * from the HUD is never polled by an agent, and a drive whose daemon is asked again later answers
 * from disk, so only the run's own start and end see every run exactly once.
 *
 * A drive the gate refuses before it starts is still a run somebody asked for, and reports as a
 * `started` + `completed: blocked` pair, so the funnel's denominator is everyone who pressed Run.
 */
import { asRecord } from '@reticlehq/core';
import { JourneyBy } from '@reticlehq/core/artifacts';
import {
  HarnessRunOutcome,
  HarnessRunPhase,
  HarnessRunReason,
  HarnessRunSource,
  TelemetryEventKind,
  countBucket,
  type HarnessRun,
} from '@reticlehq/core/telemetry';
import { DriveOrigin, DriveRefusedError, DriveStatus } from '@/features/harness/drive-runs.js';
import { getTelemetry, type Telemetry } from './telemetry.js';

export interface HarnessRunStart {
  source: HarnessRunSource;
  hosted: boolean;
}

const SOURCE_OF: Record<DriveOrigin, HarnessRunSource> = {
  [DriveOrigin.AGENT]: HarnessRunSource.AGENT,
  [DriveOrigin.HUD]: HarnessRunSource.HUD,
  [DriveOrigin.CHAT]: HarnessRunSource.DASHBOARD,
  [DriveOrigin.TRY]: HarnessRunSource.CLI_TRY,
};

/** Who started it. A saved plan is a plan whoever pressed Run. */
export function harnessRunSource(
  origin: DriveOrigin,
  planId: string | undefined,
): HarnessRunSource {
  return planId === undefined ? SOURCE_OF[origin] : HarnessRunSource.PLAN;
}

/** How a finished run ended, from what the registry recorded. */
export function harnessRunEnd(
  status: DriveStatus,
  result: Record<string, unknown> | undefined,
  reason?: HarnessRunReason,
): Pick<HarnessRun, 'outcome' | 'journeys' | 'replayed' | 'reason'> {
  const journeys = Array.isArray(result?.['journeys']) ? result['journeys'] : undefined;
  const replayed = (journeys ?? []).filter((j) => JourneyBy.REPLAY === asRecord(j)['by']).length;
  const outcome =
    DriveStatus.REFUSED === status
      ? HarnessRunOutcome.BLOCKED
      : DriveStatus.BROKEN === status
        ? HarnessRunOutcome.FAILED
        : DriveStatus.STOPPED === status
          ? HarnessRunOutcome.STOPPED
          : true === result?.['proved']
            ? HarnessRunOutcome.PROVED
            : HarnessRunOutcome.NOT_PROVED;
  // An unplanned drive is one journey; a refused one drove none.
  const count = journeys?.length ?? (HarnessRunOutcome.BLOCKED === outcome ? 0 : 1);
  // Why it did not drive: only a blocked or failed run has a reason, and a break names itself.
  const why =
    HarnessRunOutcome.BLOCKED === outcome
      ? (reason ?? HarnessRunReason.OTHER)
      : HarnessRunOutcome.FAILED === outcome
        ? (reason ?? HarnessRunReason.BROKEN)
        : undefined;
  return {
    outcome,
    journeys: countBucket(count),
    replayed: countBucket(replayed),
    ...(why === undefined ? {} : { reason: why }),
  };
}

function emit(telemetry: Pick<Telemetry, 'emit'>, harness: HarnessRun): void {
  try {
    void telemetry.emit(TelemetryEventKind.HARNESS_RUN, { harness });
  } catch {
    /* a metric may never change a drive */
  }
}

/** Report the run's start, run it, report its end, and hand back exactly what it did. */
export async function reportHarnessRun<
  T extends { status: DriveStatus; result: Record<string, unknown> },
>(
  start: HarnessRunStart,
  run: () => Promise<T>,
  refused: (error: unknown) => boolean,
  telemetry: Pick<Telemetry, 'emit'> = getTelemetry(),
): Promise<T> {
  emit(telemetry, { phase: HarnessRunPhase.STARTED, ...start });
  try {
    const done = await run();
    emit(telemetry, {
      phase: HarnessRunPhase.COMPLETED,
      ...start,
      ...harnessRunEnd(done.status, done.result),
    });
    return done;
  } catch (error) {
    emit(telemetry, {
      phase: HarnessRunPhase.COMPLETED,
      ...start,
      ...harnessRunEnd(
        refused(error) ? DriveStatus.REFUSED : DriveStatus.BROKEN,
        undefined,
        error instanceof DriveRefusedError ? error.reason : undefined,
      ),
    });
    throw error;
  }
}

/** A run the gate refused before it could start: still somebody who asked for one. */
export function reportHarnessBlocked(
  start: HarnessRunStart,
  reason: HarnessRunReason,
  telemetry: Pick<Telemetry, 'emit'> = getTelemetry(),
): void {
  emit(telemetry, { phase: HarnessRunPhase.STARTED, ...start });
  emit(telemetry, {
    phase: HarnessRunPhase.COMPLETED,
    ...start,
    ...harnessRunEnd(DriveStatus.REFUSED, undefined, reason),
  });
}
