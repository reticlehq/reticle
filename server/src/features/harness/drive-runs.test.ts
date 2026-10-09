import { afterEach, describe, expect, it } from 'vitest';
import {
  DriveOrigin,
  DriveStatus,
  awaitDrive,
  driveRecord,
  forgetDrives,
  noteDriveLine,
  noteDriveStep,
  onDriveStep,
  runningDrive,
  sayToDrive,
  startDrive,
  stopDrive,
  takeDriveNotes,
  type DriveControl,
} from './drive-runs.js';

/** A drive the test finishes by hand, so nothing here waits on a clock. */
function heldDrive(harness: string, sessionId?: string) {
  let finish: (result: Record<string, unknown>) => void = () => undefined;
  let control: DriveControl | undefined;
  const written: string[] = [];
  const record = startDrive({
    harness,
    runId: `harness-${harness}`,
    origin: DriveOrigin.AGENT,
    ...(sessionId === undefined ? {} : { sessionId }),
    now: () => 1000,
    persist: (r) => {
      written.push(r.status);
      return Promise.resolve();
    },
    run: (c) => {
      control = c;
      return new Promise((resolve) => {
        finish = (result) => resolve({ status: DriveStatus.DONE, result });
      });
    },
  });
  return {
    record,
    finish: (r: Record<string, unknown>) => finish(r),
    control: () => control,
    written,
  };
}

afterEach(() => forgetDrives());

describe('a Harness drive the agent can poll', () => {
  it('has its run id before the drive does anything, and is running', () => {
    const { record } = heldDrive('h1');
    expect(record.harnessRun).toBe('harness-h1');
    expect(driveRecord('harness-h1')?.status).toBe(DriveStatus.RUNNING);
  });

  it('counts steps from every lane of the drive, and keeps the latest line', () => {
    heldDrive('h2');
    noteDriveStep('h2', 'reticle_snapshot');
    noteDriveStep('h2-L2', 'reticle_act');
    noteDriveLine('h2', 'Harness finished');
    const record = driveRecord('harness-h2');
    expect(record?.steps).toBe(2);
    expect(record?.lastLine).toBe('Harness finished');
  });

  it('answers a wait as soon as the drive ends, with its result kept', async () => {
    const { finish, written } = heldDrive('h3');
    const waited = awaitDrive('harness-h3', 60_000);
    finish({ summary: 'ok' });
    await waited;
    const record = driveRecord('harness-h3');
    expect(record?.status).toBe(DriveStatus.DONE);
    expect(record?.result).toEqual({ summary: 'ok' });
    expect(written).toEqual([DriveStatus.RUNNING, DriveStatus.DONE]);
  });

  it('gives up waiting when the caller goes away, and the drive keeps running', async () => {
    heldDrive('h4');
    const gone = new AbortController();
    const waited = awaitDrive('harness-h4', 60_000, gone.signal);
    gone.abort();
    await waited;
    expect(driveRecord('harness-h4')?.status).toBe(DriveStatus.RUNNING);
  });

  it('reports progress to a waiter on each step', async () => {
    const { finish } = heldDrive('h5');
    const seen: number[] = [];
    const waited = awaitDrive('harness-h5', 60_000, undefined, (r) => seen.push(r.steps));
    noteDriveStep('h5', 'reticle_act');
    noteDriveStep('h5', 'reticle_act');
    finish({});
    await waited;
    expect(seen.slice(0, 2)).toEqual([1, 2]);
  });

  // Driven before release: the HUD row read "0 steps" for a whole drive, because only a drive's
  // start and end repainted the panel and a step changed nothing anybody listened to.
  it('tells step listeners on each step, so the panel can repaint its count', () => {
    heldDrive('h9');
    const seen: number[] = [];
    const off = onDriveStep((r) => seen.push(r.steps));
    noteDriveStep('h9', 'reticle_act');
    noteDriveStep('h9-L2', 'reticle_act');
    off();
    noteDriveStep('h9', 'reticle_act');
    expect(seen).toEqual([1, 2]);
  });

  it('finds the drive running on a session, so a second start returns it instead', () => {
    heldDrive('h6', 's1');
    expect(runningDrive('s1')?.harnessRun).toBe('harness-h6');
    expect(runningDrive('s2')).toBeUndefined();
    expect(runningDrive(undefined)?.harnessRun).toBe('harness-h6');
  });

  it('is stopped and spoken to through its control', () => {
    const { control } = heldDrive('h7');
    expect(sayToDrive('harness-h7', 'try the refund page')).toBe(true);
    expect(control()?.takeSaid()).toEqual(['try the refund page']);
    expect(control()?.takeSaid()).toEqual([]);
    expect(control()?.stopped()).toBe(false);
    expect(stopDrive('harness-h7')).toBe(true);
    expect(control()?.stopped()).toBe(true);
    expect(stopDrive('harness-nope')).toBe(false);
  });

  it('is broken, not running forever, when the drive throws', async () => {
    startDrive({
      harness: 'h8',
      runId: 'harness-h8',
      origin: DriveOrigin.HUD,
      now: () => 1,
      persist: () => Promise.resolve(),
      run: () => Promise.reject(new Error('refused')),
    });
    await awaitDrive('harness-h8', 60_000);
    expect(driveRecord('harness-h8')).toMatchObject({
      status: DriveStatus.BROKEN,
      error: 'refused',
    });
  });

  it('tells the agent once when a drive starts and when it ends, never twice', async () => {
    const { finish } = heldDrive('h9');
    expect(takeDriveNotes()).toEqual([expect.stringContaining('harness-h9 is running')]);
    expect(takeDriveNotes()).toEqual([]);
    finish({ checks: { held: 2, failed: 1, undecided: 0 } });
    await awaitDrive('harness-h9', 60_000);
    expect(takeDriveNotes()).toEqual([
      expect.stringMatching(/harness-h9 finished \(done: 2 held, 1 failed, 0 undecided\)/),
    ]);
  });

  it('tells the agent a drive started from the HUD runs on its tab, with the exact poll call', () => {
    startDrive({
      harness: 'h11',
      runId: 'harness-h11',
      origin: DriveOrigin.HUD,
      sessionId: 'tab-1',
      now: () => 1,
      persist: () => Promise.resolve(),
      run: () => new Promise(() => undefined),
    });
    const [note] = takeDriveNotes();
    expect(note).toContain('started from the HUD');
    expect(note).toContain('tab-1');
    expect(note).toContain('reticle_verify {action:"explore", runId:"harness-h11"}');
    expect(note).toContain('keeps running');
    stopDrive('harness-h11');
  });

  it('delivers the finished drive with its own summary', async () => {
    const { finish } = heldDrive('h12');
    takeDriveNotes();
    finish({ checks: { held: 1, failed: 0, undecided: 0 }, summary: 'Drove checkout.\nmore' });
    await awaitDrive('harness-h12', 60_000);
    const [note] = takeDriveNotes();
    expect(note).toContain('1 held, 0 failed, 0 undecided');
    expect(note).toContain('Drove checkout.');
    expect(note).not.toContain('more');
  });

  it('does not tell the agent about the drive it is already reading', () => {
    heldDrive('h10');
    expect(takeDriveNotes('harness-h10')).toEqual([]);
    expect(takeDriveNotes()).toEqual([]);
  });
});
