import { afterEach, describe, expect, it } from 'vitest';
import { HumanControlKind } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
// The tool table first, as the daemon loads it: the explore module sits on an import cycle with it.
import './tools.js';
import { hudDrive } from './chat-drives.js';
import { coverageRefusal, MSG_GATE_PROMPT_LEAD } from './harness-explore.js';
import { answerExplore } from './explore-tools.js';
import { getSessionMetrics, resetSessionMetrics } from '@/telemetry/session-metrics.js';
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

afterEach(() => {
  forgetDrives();
  resetSessionMetrics();
});

/** A tab that announced these channels, as the daemon's session list resolves it. */
function tabDeps(channels: string[], said: string[] = []): ToolDeps {
  const tab = {
    id: 's1',
    url: 'http://localhost:5173/',
    channels,
    sourceMapping: true,
    pushNarration: (t: string) => said.push(t),
  };
  return {
    linkedCloud: () => Promise.resolve({ apiKey: 'rk_live_x', url: 'https://app.reticle.test' }),
    sessions: { get: () => tab, resolve: () => tab },
  } as unknown as ToolDeps;
}
/** No store and no signals: 5 of 8, below the gate. */
const BELOW = ['ui', 'net', 'log'];
/** Everything but test ids: 7 of 8. */
const ABOVE = ['ui', 'net', 'log', 'state', 'signal'];

describe('the Harness coverage gate', () => {
  it('refuses below 80% with one reason sentence, then the prompt that closes it', () => {
    const refusal = coverageRefusal(tabDeps(BELOW), 's1') ?? '';
    const [reason, , lead] = refusal.split('\n');
    expect(reason).toMatch(
      /^Harness unlocks at 80% instrumentation\. This app is at 62%: missing /,
    );
    expect(lead).toBe(MSG_GATE_PROMPT_LEAD);
    expect(refusal).toContain('reticle verify http://localhost:5173/');
    expect(getSessionMetrics().summarize(false).harnessRefusedCoverage).toEqual({ '60-79': 1 });
  });

  it('lets a drive start at 80% or more', () => {
    expect(coverageRefusal(tabDeps(ABOVE), 's1')).toBeUndefined();
  });

  it('refuses an agent explore below the gate before anything is started', async () => {
    await expect(
      answerExplore(tabDeps(BELOW), {}, undefined, () => {
        throw new Error('must not drive');
      }),
    ).rejects.toThrow(/^Harness unlocks at 80%/);
  });

  it('refuses Run Harness below the gate without asking the platform for a grant', async () => {
    const said: string[] = [];
    let asked = false;
    await hudDrive(
      tabDeps(BELOW, said),
      's1',
      { kind: HumanControlKind.HARNESS_RUN },
      noSwitch,
      () => {
        asked = true;
        return Promise.resolve({ granted: false, needsCard: false, message: 'no' });
      },
    );
    expect(asked).toBe(false);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Harness unlocks at 80% instrumentation\. This app is at 62%/);
  });
});

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
