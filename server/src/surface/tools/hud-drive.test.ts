import { afterEach, describe, expect, it } from 'vitest';
import { HumanControlKind } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
// The tool table first, as the daemon loads it: the explore module sits on an import cycle with it.
import './tools.js';
import { hudDrive } from './chat-drives.js';
import { DriveOrigin, forgetDrives, startDrive } from '@/features/harness/drive-runs.js';

/*
 * The HUD's Harness switch only toggled the platform's autonomous mode; nothing on the panel could
 * start a drive. Run Harness now asks the platform for the grant and starts one; Stop ends it.
 */
function deps(said: string[]): ToolDeps {
  return {
    linkedCloud: () => Promise.resolve({ apiKey: 'rk_live_x', url: 'https://app.reticle.test' }),
    sessions: { get: () => ({ pushNarration: (t: string) => said.push(t) }) },
  } as unknown as ToolDeps;
}

const noSwitch = (): void => undefined;

afterEach(() => forgetDrives());

describe("the panel's Harness controls", () => {
  it('leaves the switch as it was: written through to the platform', async () => {
    const seen: boolean[] = [];
    await hudDrive(deps([]), 's1', { kind: HumanControlKind.HARNESS, enabled: false }, (on) =>
      seen.push(on),
    );
    expect(seen).toEqual([false]);
  });

  it('asks for a card with the trial link when the platform wants one, and drives nothing', async () => {
    const said: string[] = [];
    const kinds: string[] = [];
    await hudDrive(deps(said), 's1', { kind: HumanControlKind.HARNESS_RUN }, noSwitch, () => {
      kinds.push('asked');
      return Promise.resolve({ granted: false, needsCard: true, message: 'Your trial has ended.' });
    });
    expect(kinds).toEqual(['asked']);
    expect(said).toEqual([
      'Your trial has ended.',
      'Start your trial: https://app.reticle.test/settings?group=billing',
    ]);
  });

  it('stops the drive running in this tab', async () => {
    let stopped = (): boolean => false;
    startDrive({
      harness: 'h1',
      runId: 'harness-h1',
      origin: DriveOrigin.HUD,
      sessionId: 's1',
      now: () => 0,
      persist: () => Promise.resolve(),
      run: (control) => {
        stopped = control.stopped;
        return new Promise(() => undefined);
      },
    });
    await hudDrive(deps([]), 's1', { kind: HumanControlKind.HARNESS_STOP }, noSwitch);
    expect(stopped()).toBe(true);
  });

  it('says so when Stop finds nothing to stop', async () => {
    const said: string[] = [];
    await hudDrive(deps(said), 's1', { kind: HumanControlKind.HARNESS_STOP }, noSwitch);
    expect(said).toEqual(['No Harness drive is running in this tab.']);
  });
});
