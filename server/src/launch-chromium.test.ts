import { describe, expect, it } from 'vitest';
import type { ChromiumLaunchOptions } from './chromium-launch-options.js';
import {
  announceOnce,
  ChromiumChannel,
  channelExecutableCandidates,
  launchChromium,
  resolveChromiumTarget,
  type ChromiumTargetDeps,
} from './launch-chromium.js';

const BUNDLED = '/cache/ms-playwright/chromium-1223/chrome';
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAC_EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

/** A fake machine: `present` is the set of files that exist; `install` adds the bundled build. */
function machine(present: string[], opts: { installSucceeds?: boolean } = {}) {
  const files = new Set(present);
  const announced: string[] = [];
  let installs = 0;
  const deps: ChromiumTargetDeps = {
    executablePath: () => BUNDLED,
    exists: (p) => files.has(p),
    platform: 'darwin',
    env: {},
    install: () => {
      installs += 1;
      if (false !== opts.installSucceeds) files.add(BUNDLED);
      return Promise.resolve(false !== opts.installSucceeds);
    },
    announce: (line) => announced.push(line),
  };
  return { deps, announced, installs: () => installs };
}

describe('resolveChromiumTarget', () => {
  it('uses the bundled Chromium when it is on disk, and installs nothing', async () => {
    const m = machine([BUNDLED, MAC_CHROME]);
    expect(await resolveChromiumTarget(m.deps)).toEqual({ found: true });
    expect(m.installs()).toBe(0);
    expect(m.announced).toEqual([]);
  });

  // The fresh-machine failure: the playwright package is there, its browser build is not, and every
  // Reticle-owned browser used to refuse with an install command the user had to go and run.
  it('falls back to an installed Google Chrome before downloading anything', async () => {
    const m = machine([MAC_CHROME]);
    expect(await resolveChromiumTarget(m.deps)).toEqual({
      found: true,
      channel: ChromiumChannel.CHROME,
    });
    expect(m.installs()).toBe(0);
    expect(m.announced.join('\n')).toMatch(/Google Chrome/);
  });

  it('falls back to Microsoft Edge when Chrome is absent', async () => {
    const m = machine([MAC_EDGE]);
    expect(await resolveChromiumTarget(m.deps)).toEqual({
      found: true,
      channel: ChromiumChannel.MSEDGE,
    });
    expect(m.installs()).toBe(0);
  });

  it('installs the pinned Chromium only when no browser exists at all, and says so', async () => {
    const m = machine([]);
    expect(await resolveChromiumTarget(m.deps)).toEqual({ found: true });
    expect(m.installs()).toBe(1);
    expect(m.announced.join('\n')).toMatch(/installing/i);
  });

  it('reports not found when the install fails, so the caller keeps the install hint', async () => {
    const m = machine([], { installSucceeds: false });
    expect(await resolveChromiumTarget(m.deps)).toEqual({ found: false });
  });

  // A playwright that cannot name its own executable is not evidence the browser is missing; let the
  // launch speak for itself rather than download a browser on a guess.
  it('treats an unanswerable executablePath as bundled', async () => {
    const m = machine([]);
    const deps = {
      ...m.deps,
      executablePath: () => {
        throw new Error('no');
      },
    };
    expect(await resolveChromiumTarget(deps)).toEqual({ found: true });
    expect(m.installs()).toBe(0);
  });
});

describe('channelExecutableCandidates', () => {
  it('looks under every Windows install root Playwright itself checks', () => {
    const paths = channelExecutableCandidates(ChromiumChannel.CHROME, 'win32', {
      LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    });
    expect(paths).toEqual([
      'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ]);
  });

  it('knows the Linux install paths', () => {
    expect(channelExecutableCandidates(ChromiumChannel.MSEDGE, 'linux', {})).toEqual([
      '/opt/microsoft/msedge/msedge',
    ]);
  });
});

describe('launchChromium', () => {
  it('passes the resolved channel to chromium.launch alongside the shared options', async () => {
    const m = machine([MAC_CHROME]);
    const calls: unknown[] = [];
    const browser = await launchChromium(
      {
        executablePath: () => BUNDLED,
        launch: (opts: unknown) => {
          calls.push(opts);
          return Promise.resolve('browser');
        },
      },
      true,
      m.deps,
    );
    expect(browser).toBe('browser');
    expect(calls[0]).toMatchObject({ headless: true, channel: ChromiumChannel.CHROME });
  });

  it('launches with no channel when nothing could be found, so Playwright reports the real error', async () => {
    const m = machine([], { installSucceeds: false });
    const calls: ChromiumLaunchOptions[] = [];
    await launchChromium(
      {
        executablePath: () => BUNDLED,
        launch: (opts: ChromiumLaunchOptions) => {
          calls.push(opts);
          return Promise.resolve('browser');
        },
      },
      false,
      m.deps,
    );
    expect(calls[0]).not.toHaveProperty('channel');
  });
});

/*
 * The Chrome/Edge fallback line was written on EVERY launch, so a pool opening a few contexts
 * printed the same notice over and over into the terminal of whoever started the daemon.
 */
describe('the fallback notice', () => {
  it('is written once per process, however many launches resolve to it', () => {
    const written: string[] = [];
    const announce = announceOnce((line) => written.push(line));
    announce('using Chrome\n');
    announce('using Chrome\n');
    announce('installing\n');
    expect(written).toEqual(['using Chrome\n', 'installing\n']);
  });
});
