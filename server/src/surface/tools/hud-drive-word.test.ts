/**
 * The Harness page says how a run ended, or why none started, on the page itself (matrix drive,
 * bench-app with the HUD shown):
 * - the cloud unreachable: Run went to Starting… and back to Run, with no word;
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HumanControlKind, type ImpactSnapshot } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
// The tool table first, as the daemon loads it: the explore module sits on an import cycle with it.
import './tools.js';
import { hudDrive } from './chat-drives.js';
import { forgetDrives, withRunningDrive } from '@/features/harness/drive-runs.js';
import { requestFreeDrive, FreeDriveKind } from '@/features/harness/platform/platform-drives.js';

const SNAPSHOT = { schemaVersion: 1 } as unknown as ImpactSnapshot;
const noSwitch = (): void => undefined;

function deps(said: string[]): ToolDeps {
  const tab = {
    id: 's1',
    url: 'http://localhost:5173/',
    channels: ['ui', 'net', 'log', 'state', 'signal'],
    sourceMapping: true,
    pushNarration: (t: string) => said.push(t),
  };
  return {
    linkedCloud: () => Promise.resolve({ apiKey: 'rk_live_x', url: 'http://localhost:1' }),
    sessions: { get: () => tab, resolve: () => tab, list: () => [] },
  } as unknown as ToolDeps;
}

afterEach(() => {
  forgetDrives();
});

describe('Run Harness with the cloud unreachable', () => {
  it('says the cloud did not answer, naming it and what to do', async () => {
    const answer = await requestFreeDrive(
      { url: 'http://localhost:1', apiKey: 'rk_live_x' },
      FreeDriveKind.EXPLORE,
      () => Promise.reject(new TypeError('fetch failed')),
    );
    expect(answer.granted).toBe(false);
    expect(answer.granted ? '' : answer.message).toMatch(
      /^Reticle Cloud at http:\/\/localhost:1 did not answer.*Run again/,
    );
  });

  // Night 7b: a cloud that takes the connection and never answers held the grant with no bound.
  it('says the cloud did not answer when the grant hangs, within its bound', async () => {
    const hangs = (_url: string, init: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const answer = await requestFreeDrive(
      { url: 'http://localhost:1', apiKey: 'rk_live_x' },
      FreeDriveKind.EXPLORE,
      hangs,
      50,
    );
    expect(answer.granted ? '' : answer.message).toMatch(/did not answer/);
  });

  it('numbers each word, so the page can tell a new answer from the last one', async () => {
    const said: string[] = [];
    const refuse = () =>
      Promise.resolve({ granted: false as const, needsCard: false, message: 'No.' });
    await hudDrive(deps(said), 's1', { kind: HumanControlKind.HARNESS_RUN }, noSwitch, refuse);
    const first = withRunningDrive(SNAPSHOT, 's1')?.lastDrive?.seq ?? -1;
    await hudDrive(deps(said), 's1', { kind: HumanControlKind.HARNESS_RUN }, noSwitch, refuse);
    expect(withRunningDrive(SNAPSHOT, 's1')?.lastDrive?.seq ?? -1).toBeGreaterThan(first);
  });

  it('leaves that line on the Harness page, for this tab', async () => {
    const said: string[] = [];
    await hudDrive(deps(said), 's1', { kind: HumanControlKind.HARNESS_RUN }, noSwitch, () =>
      Promise.resolve({
        granted: false,
        needsCard: false,
        message: 'Reticle Cloud did not answer.',
      }),
    );
    expect(said).toEqual(['Reticle Cloud did not answer.']);
    expect(withRunningDrive(SNAPSHOT, 's1')?.lastDrive?.said).toBe('Reticle Cloud did not answer.');
  });

  it('says why when starting threw, rather than nothing', async () => {
    const said: string[] = [];
    await hudDrive(deps(said), 's1', { kind: HumanControlKind.HARNESS_RUN }, noSwitch, () =>
      Promise.reject(new Error('socket hang up')),
    );
    expect(said.join(' ')).toMatch(/socket hang up/);
    expect(withRunningDrive(SNAPSHOT, 's1')?.lastDrive?.said).toMatch(/socket hang up/);
  });
});
