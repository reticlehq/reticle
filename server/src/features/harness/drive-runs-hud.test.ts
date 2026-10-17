/**
 * What the HUD's Harness page reads from the daemon, so it survives the page being closed, reopened
 * or reloaded (matrix drive, bench-app with the HUD shown):
 * - the step log was view state: closed and reopened mid-run, the log was empty;
 * - at the end there was no link to the run's result, only the project overview;
 * - a reload mid-run ended the journey failed, with no word why;
 * - a refusal (the cloud unreachable) left Run as it was, with no word on the page.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventType, NetInitiator, type ImpactSnapshot, type ReticleEvent } from '@reticlehq/core';
import {
  DriveOrigin,
  DriveStatus,
  awaitDrive,
  forgetDrives,
  MSG_RELOADED,
  noteDriveLine,
  noteOwnReload,
  notePageLoaded,
  noteHarnessWord,
  startDrive,
  stopDrive,
  withRunningDrive,
} from './drive-runs.js';

const SNAPSHOT = { schemaVersion: 1 } as unknown as ImpactSnapshot;

function drive(harness: string, sessionId: string, result: Record<string, unknown> = {}) {
  let finish: () => void = () => undefined;
  startDrive({
    harness,
    runId: `harness-${harness}`,
    origin: DriveOrigin.HUD,
    sessionId,
    now: () => 1000,
    persist: () => Promise.resolve(),
    run: (control) =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            status: control.stopped() ? DriveStatus.STOPPED : DriveStatus.DONE,
            result,
          });
      }),
  });
  return { finish: () => finish() };
}

afterEach(() => forgetDrives());

describe('the Harness page reads its run from the snapshot', () => {
  it('carries the step log of the running drive', () => {
    drive('a', 's1');
    noteDriveLine('a', 'Opened /deployments');
    noteDriveLine('a', 'Clicked "New deploy"');
    expect(withRunningDrive(SNAPSHOT, 's1')?.harnessDrive?.lines).toEqual([
      'Opened /deployments',
      'Clicked "New deploy"',
    ]);
  });

  it('links the run once the drive has ended', async () => {
    const run = drive('b', 's1', { runUrl: 'http://localhost:5173/runs/harness-b' });
    run.finish();
    await awaitDrive('harness-b', 1000);
    await Promise.resolve();
    const snap = withRunningDrive(SNAPSHOT, 's1');
    expect(snap?.harnessDrive).toBeUndefined();
    expect(snap?.lastDrive?.runUrl).toBe('http://localhost:5173/runs/harness-b');
  });

  it('says why a drive stopped when something other than the person stopped it', async () => {
    const run = drive('c', 's1');
    stopDrive('harness-c', 'The page reloaded, so this run stopped. Run again.');
    run.finish();
    await awaitDrive('harness-c', 1000);
    await Promise.resolve();
    expect(withRunningDrive(SNAPSHOT, 's1')?.lastDrive?.said).toBe(
      'The page reloaded, so this run stopped. Run again.',
    );
  });

  it('carries a refusal said before any drive started, for that tab only', () => {
    noteHarnessWord('s1', 'Reticle Cloud did not answer.');
    expect(withRunningDrive(SNAPSHOT, 's1')?.lastDrive?.said).toBe('Reticle Cloud did not answer.');
    expect(withRunningDrive(SNAPSHOT, 's2')?.lastDrive).toBeUndefined();
  });

  it('forgets the last word when a new drive starts', () => {
    noteHarnessWord('s1', 'Reticle Cloud did not answer.');
    drive('d', 's1');
    expect(withRunningDrive(SNAPSHOT, 's1')?.lastDrive).toBeUndefined();
  });
});

describe('a person reloading the page mid-run', () => {
  const loaded = (navigationType: string): ReticleEvent =>
    ({
      type: EventType.NET_REQUEST,
      t: 1,
      data: { initiator: NetInitiator.DOCUMENT, navigationType, url: 'http://localhost:4612/' },
    }) as unknown as ReticleEvent;

  async function ended(harness: string): Promise<string | undefined> {
    await awaitDrive(`harness-${harness}`, 50);
    await Promise.resolve();
    return withRunningDrive(SNAPSHOT, 's1')?.lastDrive?.said;
  }

  it('stops the drive on that tab and says why on its Harness page', async () => {
    const run = drive('r1', 's1');
    notePageLoaded('s1', loaded('reload'), 10_000);
    run.finish();
    expect(await ended('r1')).toBe(MSG_RELOADED);
  });

  it('is not a reload the daemon asked for moments before', async () => {
    const run = drive('r2', 's1');
    noteOwnReload('s1', 10_000);
    notePageLoaded('s1', loaded('reload'), 12_000);
    run.finish();
    expect(await ended('r2')).toBeUndefined();
  });

  it('is not a first load or a click-through', async () => {
    const run = drive('r3', 's1');
    notePageLoaded('s1', loaded('navigate'), 10_000);
    run.finish();
    expect(await ended('r3')).toBeUndefined();
  });

  it('leaves a drive on another tab alone', async () => {
    const run = drive('r4', 's1');
    notePageLoaded('s2', loaded('reload'), 10_000);
    run.finish();
    expect(await ended('r4')).toBeUndefined();
  });
});
