import { afterEach, describe, expect, it } from 'vitest';
import { HumanControlKind } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
// The tool table first, as the daemon loads it: the explore module sits on an import cycle with it.
import './tools.js';
import { hudDrive, unsyncedReport } from './chat-drives.js';
import { coverageRefusal, harnessLockRefusal, MSG_GATE_PROMPT_LEAD } from './harness-explore.js';
import type { ConfigFetch } from '@/features/harness/platform-config.js';
import { answerExplore } from './explore-tools.js';
import { getSessionMetrics, resetSessionMetrics } from '@/telemetry/session-metrics.js';
import { DriveOrigin, forgetDrives, startDrive } from '@/features/harness/drive-runs.js';
import { forgetAllRecordedGaps } from '@/portal/session/recorded-gaps.js';

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

/**
 * The daemon refused (or the platform locked mid-drive) at 75% while `/v1/model/config` said 87.5%
 * unlocked in the same minute. A linked project's platform verdict is the one the lock obeys.
 */
describe('the platform gate is the lock when the project is linked', () => {
  const LINKED = { RETICLE_API_KEY: 'rk_live_x', RETICLE_CLOUD_URL: 'https://app.reticle.test' };
  const answering =
    (unlocked: boolean): ConfigFetch =>
    () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ provider: 'jev', harnessUnlocked: unlocked, coverageScore: 0.875 }),
          ),
      });

  it('lets a run start that the platform unlocked, whatever this tab scores', async () => {
    expect(await harnessLockRefusal(tabDeps(BELOW), 's1', LINKED, answering(true))).toBeUndefined();
  });

  it("keeps the daemon's sentence when the platform says locked too", async () => {
    expect(await harnessLockRefusal(tabDeps(BELOW), 's1', LINKED, answering(false))).toMatch(
      /^Harness unlocks at 80% instrumentation/,
    );
  });

  it('refuses on its own reading when no platform answers', async () => {
    expect(await harnessLockRefusal(tabDeps(BELOW), 's1', {})).toMatch(/^Harness unlocks at 80%/);
  });

  it('asks nothing of the platform when this tab is already above the gate', async () => {
    let asked = false;
    const spy: ConfigFetch = () => {
      asked = true;
      return answering(false)('', { method: 'GET', headers: {} });
    };
    expect(await harnessLockRefusal(tabDeps(ABOVE), 's1', LINKED, spy)).toBeUndefined();
    expect(asked).toBe(false);
  });
});

/**
 * BLOCKER from the whole-platform drive: bench-app (55 test ids, a source stamp on every element)
 * was refused at 75% ("missing file:line source mapping, stable test ids") because nothing had acted
 * on it yet. The gate asks the page what it carries before it refuses.
 */
describe('the gate reads what the page carries', () => {
  afterEach(() => {
    forgetAllRecordedGaps();
  });
  const FULL = ['ui', 'net', 'log', 'state', 'signal'];
  function pageDeps(markers: string[]): ToolDeps {
    const tab = {
      id: 'bench',
      url: 'http://localhost:4312/',
      projectId: 'bench-app',
      channels: FULL,
      command: (name: string) =>
        Promise.resolve(
          'markers' === name ? { ok: true, result: { markers } } : { ok: false, error: 'no' },
        ),
    };
    return {
      sessions: { get: () => tab, resolve: () => tab, list: () => [] },
    } as unknown as ToolDeps;
  }

  it('lets a fully instrumented app run before anything acted on it', async () => {
    expect(await harnessLockRefusal(pageDeps(['source', 'testid']), 'bench', {})).toBeUndefined();
  });

  it('still refuses a page that carries neither', async () => {
    expect(await harnessLockRefusal(pageDeps([]), 'bench', {})).toMatch(
      /This app is at 75%: missing file:line source mapping, stable test ids/,
    );
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

/**
 * A monorepo's dashboard said "1 run … was never sent" for runs it had on the board, through ten
 * reloads: once the list was empty the daemon left it out, and the platform keeps the last word when
 * the key is absent.
 */
describe('what the daemon reports as never sent', () => {
  it('says "nothing" once it has counted, rather than saying nothing', () => {
    expect(unsyncedReport([], '/home/me')).toEqual({ unsynced: [] });
    expect(unsyncedReport(undefined, '/home/me')).toEqual({});
  });

  // Persona drive: a board advised `reticle connect` inside ~/.reticle/unmatched/…, a folder the
  // CLI refuses to connect; the report carries each folder's project so a board keeps its own.
  it("leaves out the folders no project claimed, and names each folder's project", () => {
    expect(
      unsyncedReport(
        [
          { root: '/home/me/.reticle/unmatched/acme-web-69892493', runs: 2, linked: false },
          { root: '/home/me/mono/.reticle', runs: 1, linked: false, projectId: 'mono-1234abcd' },
        ],
        '/home/me',
      ),
    ).toEqual({
      unsynced: [{ root: '~/mono', runs: 1, linked: false, projectId: 'mono-1234abcd' }],
    });
  });

  it('names the project folder, home-relative', () => {
    expect(
      unsyncedReport(
        [{ root: '/home/me/mono/apps/web/.reticle', runs: 1, linked: false }],
        '/home/me',
      ),
    ).toEqual({ unsynced: [{ root: '~/mono/apps/web', runs: 1, linked: false }] });
  });
});
