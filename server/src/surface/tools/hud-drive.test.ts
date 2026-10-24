import { afterEach, describe, expect, it } from 'vitest';
import { HumanControlKind } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
// The tool table first, as the daemon loads it: the explore module sits on an import cycle with it.
import './tools.js';
import { hudDrive, unsyncedReport } from './chat-drives.js';
import { harnessStartRefusal } from './harness-explore.js';
import { resetSessionMetrics } from '@/telemetry/session-metrics.js';
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
/** No store and no signals: 5 of 8, a low setup score. */
const LOW = ['ui', 'net', 'log'];
/** Everything but test ids: 7 of 8. */
const ABOVE = ['ui', 'net', 'log', 'state', 'signal'];

/*
 * The founder's rule: the Harness works out of the box. A setup score was a gate at 80%, and most
 * new apps could never start a run. No score refuses a drive now.
 */
describe('no setup score gates the Harness', () => {
  it('lets a drive start at a low score, or with nothing announced at all', async () => {
    expect(await harnessStartRefusal(tabDeps(LOW), 's1')).toBeUndefined();
    expect(await harnessStartRefusal(tabDeps([]), 's1')).toBeUndefined();
  });

  it('asks the platform for a grant on Run Harness at a low score', async () => {
    const said: string[] = [];
    let asked = false;
    await hudDrive(
      tabDeps(LOW, said),
      's1',
      { kind: HumanControlKind.HARNESS_RUN },
      noSwitch,
      () => {
        asked = true;
        return Promise.resolve({ granted: false, needsCard: false, message: 'no' });
      },
    );
    expect(asked).toBe(true);
    expect(said).toEqual(['no']);
  });
});

/*
 * From a headless run: the page's SDK and the daemon were different builds. Two paid drives ran,
 * and every step came back "unknown", reported as "NOT PROVED — 1 undecided". The skew was known at
 * the handshake; a drive under it can only answer undecided.
 */
describe('version skew refuses a drive before it spends anything', () => {
  it('names the skew and its fix instead of starting', async () => {
    const tab = {
      id: 's1',
      url: 'http://localhost:5173/',
      channels: ABOVE,
      sourceMapping: true,
      versionSkew: 'version skew: the page is on 3.4.0; this daemon is 3.7.0. Install 3.7.0.',
    };
    const skewed = {
      linkedCloud: () => Promise.resolve({ apiKey: 'rk_live_x', url: 'https://app.reticle.test' }),
      sessions: { get: () => tab, resolve: () => tab },
    } as unknown as ToolDeps;
    const refusal = (await harnessStartRefusal(skewed, 's1'))?.text ?? '';
    expect(refusal).toMatch(/^The page's Reticle SDK and this daemon are different builds/);
    expect(refusal).toContain('Install 3.7.0.');
  });
});

/**
 * bench-app (55 test ids, a source stamp on every element) was once refused at 75% because nothing
 * had acted on it yet. The start still asks the page what it carries, so the platform's reading is
 * current, and it never refuses on what the page lacks.
 */
describe('the start reads what the page carries', () => {
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
    expect(await harnessStartRefusal(pageDeps(['source', 'testid']), 'bench')).toBeUndefined();
  });

  it('lets a page that carries neither marker run too', async () => {
    expect(await harnessStartRefusal(pageDeps([]), 'bench')).toBeUndefined();
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
