import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolDeps } from './tool-kit.js';
// The tool table first, as the daemon loads it: the explore module sits on an import cycle with it.
import './tools.js';
import { MSG_ALREADY_DRIVING, answerExplore, type ExploreDrive } from './explore-tools.js';
import {
  DriveStatus,
  forgetDrives,
  noteDriveStep,
  type DriveControl,
} from '@/features/harness/drive-runs.js';

/*
 * A drive awaited inside the tool call outlived a 60s client timeout: the agent got no run id, the
 * daemon kept driving and spending, and a retry paid for a second drive. Now the call starts the
 * drive, waits a while, and answers `running` with the id to poll.
 */

const ROOT = '/project/.reticle';

function deps(files = new Map<string, string>()): ToolDeps {
  return {
    reticleRoot: ROOT,
    now: () => 1000,
    linkedCloud: () => Promise.resolve({ apiKey: 'rk_live_x', url: 'https://p.test' }),
    fs: {
      mkdir: () => Promise.resolve(),
      writeFile: (path: string, data: string) => {
        files.set(path, data);
        return Promise.resolve();
      },
      readFile: (path: string) => {
        const data = files.get(path);
        return data === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(data);
      },
    },
  } as unknown as ToolDeps;
}

/** A drive the test ends by hand. */
function held() {
  const controls: DriveControl[] = [];
  const harnesses: string[] = [];
  let end: (result: Record<string, unknown>) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const drive: ExploreDrive = (_deps, _env, _args, harness, control) => {
    controls.push(control);
    harnesses.push(harness);
    return new Promise((resolve, reject) => {
      end = (result) => resolve({ status: DriveStatus.DONE, result });
      fail = reject;
    });
  };
  return {
    drive,
    /** Resolves once the call has started the drive. */
    started: () => vi.waitFor(() => expect(harnesses.length).toBeGreaterThan(0)),
    controls,
    harnesses,
    end: (r: Record<string, unknown>) => end(r),
    fail: (e: Error) => fail(e),
  };
}

const record = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

afterEach(() => forgetDrives());

describe('a Harness drive, started then polled', () => {
  it('answers running with the run id when the drive outlasts the wait', async () => {
    const d = held();
    const out = record(await answerExplore(deps(), { wait: 0 }, undefined, d.drive));
    expect(out['status']).toBe(DriveStatus.RUNNING);
    expect(out['runId']).toBe(`harness-${String(d.harnesses[0])}`);
    expect(out['next']).toEqual({ action: 'explore', runId: out['runId'] });
  });

  it('answers the full result when the drive ends inside the wait', async () => {
    const d = held();
    const pending = answerExplore(deps(), { wait: 30 }, undefined, d.drive);
    await d.started();
    d.end({ summary: 'drove checkout' });
    const out = record(await pending);
    expect(out).toMatchObject({ status: DriveStatus.DONE, summary: 'drove checkout' });
  });

  it('never pays for a second drive while one is running: a second start returns the first', async () => {
    const d = held();
    const first = record(await answerExplore(deps(), { wait: 0 }, undefined, d.drive));
    const second = record(await answerExplore(deps(), { wait: 0 }, undefined, d.drive));
    expect(second['runId']).toBe(first['runId']);
    expect(second['note']).toBe(MSG_ALREADY_DRIVING);
    expect(d.harnesses).toHaveLength(1);
  });

  it('polls by run id to the end, and stops or speaks to the drive on the way', async () => {
    const d = held();
    const { runId } = record(await answerExplore(deps(), { wait: 0 }, undefined, d.drive));
    await answerExplore(deps(), { runId, wait: 0, say: 'try the refund page' }, undefined, d.drive);
    expect(d.controls[0]?.takeSaid()).toEqual(['try the refund page']);
    await answerExplore(deps(), { runId, wait: 0, stop: true }, undefined, d.drive);
    expect(d.controls[0]?.stopped()).toBe(true);
    d.end({ summary: 'stopped early' });
    const out = record(await answerExplore(deps(), { runId, wait: 30 }, undefined, d.drive));
    expect(out).toMatchObject({ status: DriveStatus.DONE, summary: 'stopped early' });
  });

  it('reports each step as progress while the call waits', async () => {
    const d = held();
    const seen: number[] = [];
    const pending = answerExplore(deps(), { wait: 30 }, { progress: (n) => seen.push(n) }, d.drive);
    await d.started();
    noteDriveStep(String(d.harnesses[0]), 'reticle_act');
    d.end({});
    await pending;
    expect(seen[0]).toBe(1);
  });

  it('stops waiting when the request goes away, and leaves the drive running', async () => {
    const d = held();
    const gone = new AbortController();
    const pending = answerExplore(deps(), { wait: 240 }, { signal: gone.signal }, d.drive);
    gone.abort();
    expect(record(await pending)['status']).toBe(DriveStatus.RUNNING);
  });

  it('reads a finished drive back from disk once this daemon no longer holds it', async () => {
    const files = new Map<string, string>();
    const d = held();
    const pending = answerExplore(deps(files), { wait: 30 }, undefined, d.drive);
    await d.started();
    d.end({ summary: 'kept' });
    const { runId } = record(await pending);
    await Promise.resolve();
    forgetDrives();
    const out = record(await answerExplore(deps(files), { runId, wait: 0 }, undefined, d.drive));
    expect(out).toMatchObject({ status: DriveStatus.DONE, summary: 'kept' });
    expect([...files.keys()]).toEqual([`${ROOT}/runs/${String(runId)}.drive.json`]);
  });

  it('reads a drive a dead daemon left running as broken, not as running forever', async () => {
    const files = new Map<string, string>();
    const d = held();
    const { runId } = record(await answerExplore(deps(files), { wait: 0 }, undefined, d.drive));
    forgetDrives();
    const out = record(await answerExplore(deps(files), { runId, wait: 0 }, undefined, d.drive));
    expect(out['status']).toBe(DriveStatus.BROKEN);
    expect(String(out['error'])).toContain('stopped before it finished');
  });

  it('keeps a refusal a refusal: a drive refused before it began throws to the caller', async () => {
    const d = held();
    const pending = answerExplore(deps(), { wait: 30 }, undefined, d.drive);
    await d.started();
    d.fail(new Error('Autonomous driving is turned OFF'));
    await expect(pending).rejects.toThrow('turned OFF');
  });
});
