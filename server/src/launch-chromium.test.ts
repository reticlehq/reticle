import { describe, expect, it } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import type { ChromiumLaunchOptions } from './chromium-launch-options.js';
import { ChromiumPathProblem } from './command/cli/doctor/browser/chromium-hint.js';
import { chromiumLaunchHint } from './portal/pool/playwright-launcher.js';
import {
  announceOnce,
  ChromiumChannel,
  channelExecutableCandidates,
  launchChromium,
  probeChromiumWithFallback,
  probeLaunchableChromium,
  resolveChromiumTarget,
  type ChromiumTargetDeps,
} from './launch-chromium.js';

const BUNDLED = '/cache/ms-playwright/chromium-1223/chrome';
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAC_EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

/**
 * A fake machine: `present` is the set of files that exist; `install` adds the bundled build.
 * `unusable` marks a present path that still cannot be launched, such as a directory.
 */
function machine(
  present: string[],
  opts: {
    installSucceeds?: boolean;
    env?: NodeJS.ProcessEnv;
    unusable?: Record<string, ChromiumPathProblem>;
  } = {},
) {
  const files = new Set(present);
  const announced: string[] = [];
  let installs = 0;
  const deps: ChromiumTargetDeps = {
    executablePath: () => BUNDLED,
    exists: (p) => files.has(p),
    pathProblem: (p) => (files.has(p) ? opts.unusable?.[p] : ChromiumPathProblem.MISSING),
    platform: 'darwin',
    env: opts.env ?? {},
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

/**
 * A machine with a Chromium somewhere Reticle would never look: a Linux sandbox with one at a custom
 * path and `playwright install` not allowed, or a macOS too old for Playwright's pinned build.
 * RETICLE_CHROMIUM_PATH names it, and nothing else is consulted.
 */
describe(`a Chromium named by ${ReticleEnv.CHROMIUM_PATH}`, () => {
  const CUSTOM = '/opt/sandbox/chromium/chrome';
  const env = { [ReticleEnv.CHROMIUM_PATH]: CUSTOM };

  it('is used as is, without probing the bundled build, a channel, or installing', async () => {
    const m = machine([CUSTOM, MAC_CHROME], { env });
    m.deps.executablePath = () => {
      throw new Error('the bundled revision was probed');
    };
    expect(await resolveChromiumTarget(m.deps)).toEqual({ found: true, executablePath: CUSTOM });
    expect(m.installs()).toBe(0);
    expect(m.announced).toEqual([]);
  });

  it('reaches chromium.launch as executablePath', async () => {
    const m = machine([CUSTOM], { env });
    const calls: ChromiumLaunchOptions[] = [];
    await launchChromium(
      {
        executablePath: () => BUNDLED,
        launch: (opts: ChromiumLaunchOptions) => {
          calls.push(opts);
          return Promise.resolve('browser');
        },
      },
      true,
      m.deps,
    );
    expect(calls[0]).toMatchObject({ headless: true, executablePath: CUSTOM });
    expect(calls[0]).not.toHaveProperty('channel');
  });

  /**
   * Playwright's own error for a missing executable is the one chromiumLaunchHint turns into
   * "install chromium", which does nothing for a path the user typed wrong.
   */
  it('refuses a path that does not exist, naming it, and never falls back or installs', async () => {
    const m = machine([BUNDLED, MAC_CHROME], { env });
    const launched: ChromiumLaunchOptions[] = [];
    const attempt = launchChromium(
      {
        executablePath: () => BUNDLED,
        launch: (opts: ChromiumLaunchOptions) => {
          launched.push(opts);
          return Promise.resolve('browser');
        },
      },
      true,
      m.deps,
    );
    await expect(attempt).rejects.toThrow(CUSTOM);
    const message = await attempt.catch((err: unknown) => (err as Error).message);
    expect(message).toContain(ReticleEnv.CHROMIUM_PATH);
    expect(chromiumLaunchHint(message)).toBeUndefined();
    expect(launched).toEqual([]);
    expect(m.installs()).toBe(0);
  });

  /** Existing is not enough: Playwright cannot start either, and says so as a missing install. */
  it.each([
    [ChromiumPathProblem.NOT_A_FILE, 'which is not a file'],
    [ChromiumPathProblem.NOT_EXECUTABLE, 'which is not executable'],
  ])('refuses a path that is %s, saying so, and never falls back', async (problem, says) => {
    const m = machine([CUSTOM, BUNDLED, MAC_CHROME], { env, unusable: { [CUSTOM]: problem } });
    const launched: ChromiumLaunchOptions[] = [];
    const attempt = launchChromium(
      {
        executablePath: () => BUNDLED,
        launch: (opts: ChromiumLaunchOptions) => {
          launched.push(opts);
          return Promise.resolve('browser');
        },
      },
      true,
      m.deps,
    );
    const message = await attempt.catch((err: unknown) => (err as Error).message);
    expect(message).toContain(`${CUSTOM}, ${says}`);
    expect(launched).toEqual([]);
    expect(m.installs()).toBe(0);
  });

  it('is ignored when blank', async () => {
    const m = machine([BUNDLED], { env: { [ReticleEnv.CHROMIUM_PATH]: '  ' } });
    expect(await resolveChromiumTarget(m.deps)).toEqual({ found: true });
  });

  it('is what doctor and the lease preflight report on', async () => {
    const present = { env, exists: (p: string) => CUSTOM === p, pathProblem: () => undefined };
    const directory = {
      env,
      exists: (p: string) => CUSTOM === p,
      pathProblem: () => ChromiumPathProblem.NOT_A_FILE,
    };
    for (const probe of [probeChromiumWithFallback, probeLaunchableChromium]) {
      expect(await probe(present)).toEqual({
        executablePath: CUSTOM,
        exists: true,
        configured: true,
      });
      expect(await probe(directory)).toEqual({
        executablePath: CUSTOM,
        exists: false,
        configured: true,
        problem: ChromiumPathProblem.NOT_A_FILE,
      });
    }
  });
});
