import { describe, expect, it } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import type { ChromiumLaunchOptions } from './chromium-launch-options.js';
import {
  ChromiumPathProblem,
  chromiumPreflightRefusal,
} from './command/cli/doctor/browser/chromium-hint.js';
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

  it('looks in /Applications and ~/Applications on macOS when HOME is set', () => {
    expect(
      channelExecutableCandidates(ChromiumChannel.CHROME, 'darwin', { HOME: '/Users/a' }),
    ).toEqual([MAC_CHROME, `/Users/a${MAC_CHROME}`]);
    expect(
      channelExecutableCandidates(ChromiumChannel.MSEDGE, 'darwin', { HOME: '/Users/a' }),
    ).toEqual([MAC_EDGE, `/Users/a${MAC_EDGE}`]);
  });
});

describe('a browser in ~/Applications on macOS (#1952)', () => {
  const HOME = '/Users/a';
  const HOME_CHROME = `${HOME}${MAC_CHROME}`;
  const env = { HOME };

  it('is found and launched by executablePath when /Applications has no Chrome', async () => {
    const m = machine([HOME_CHROME], { env });
    expect(await resolveChromiumTarget(m.deps)).toEqual({
      found: true,
      executablePath: HOME_CHROME,
    });
    expect(m.installs()).toBe(0);
    expect(m.announced.join('\n')).toMatch(/Google Chrome/);

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
    expect(calls[0]).toMatchObject({ headless: true, executablePath: HOME_CHROME });
    expect(calls[0]).not.toHaveProperty('channel');
  });

  it('loses to a Chrome in /Applications, which still launches by channel', async () => {
    const m = machine([MAC_CHROME, HOME_CHROME], { env });
    expect(await resolveChromiumTarget(m.deps)).toEqual({
      found: true,
      channel: ChromiumChannel.CHROME,
    });
  });

  it('is named alongside /Applications in the refusal when no browser is found', async () => {
    const m = machine([], { env, installSucceeds: false });
    for (const probe of [probeChromiumWithFallback, probeLaunchableChromium]) {
      const refusal = chromiumPreflightRefusal(await probe(m.deps)) ?? '';
      expect(refusal).toContain(MAC_CHROME);
      expect(refusal).toContain(HOME_CHROME);
    }
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

describe('the launch failure hint (#691)', () => {
  /**
   * The Oct 12 field report: the install the hint names succeeds in the reporter's shell, and
   * acquire still refuses, because the daemon looks in a different browsers root (its HOME or
   * PLAYWRIGHT_BROWSERS_PATH differs). The preflight and doctor messages name the probed path;
   * the launch translation replaced the whole error with a bare command and threw the path away,
   * so the divergence was invisible in the one message the reporter actually read.
   *
   * The path comes from Playwright's own error, which names the build the failed launch
   * actually used — the bundled build, the RETICLE_CHROMIUM_PATH executable, or an installed
   * Chrome or Edge — never from a fresh bundled-path lookup that can name a build nobody tried.
   */
  it('names the path the failed launch used, even when it is not the bundled path', () => {
    const hint = chromiumLaunchHint(
      "browserType.launch: Executable doesn't exist at /opt/reticle/chromium/chrome",
    );
    expect(hint).toContain('Chromium is not installed for Playwright');
    expect(hint).toContain('looked for /opt/reticle/chromium/chrome');
    expect(hint).toContain('install chromium');
  });

  /**
   * A Windows account name can hold a space, such as C:\Users\Jo Doe. The pattern must read
   * to the end of the line, or the message names C:\Users\Jo, a path that does not exist.
   */
  it('names the full path when the path contains a space', () => {
    const hint = chromiumLaunchHint(
      "browserType.launch: Executable doesn't exist at " +
        'C:\\Users\\Jo Doe\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win\\chrome.exe\n' +
        'Looks like Playwright Test or Playwright was just installed or updated.',
    );
    expect(hint).toContain('Chromium is not installed for Playwright');
    expect(hint).toContain(
      'looked for C:\\Users\\Jo Doe\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win\\chrome.exe',
    );
  });

  it('keeps the bare command when the failure names no path', () => {
    const hint = chromiumLaunchHint('browserType.launch: Target crashed unexpectedly');
    expect(hint).toMatch(/^Chromium is not installed for Playwright\. Run: /);
    expect(hint).toContain('install chromium');
    expect(hint).not.toContain('looked for');
  });

  it('still sends a missing-shared-library failure to install-deps', () => {
    const hint = chromiumLaunchHint(
      'browserType.launch: Host system is missing dependencies to run browsers.',
    );
    expect(hint).toContain('install-deps chromium');
    expect(hint).not.toContain('looked for');
  });
});
