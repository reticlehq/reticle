/**
 * The ONE place a Reticle-owned Chromium is launched — the pooled lease browser
 * (`playwright-launcher`) and the drive browser (`real-input`) both come through here.
 *
 * Why it is more than `chromium.launch`: on a fresh machine the `playwright` package is present
 * (npx pulled it in with the server) but its browser build is not, because that is a separate
 * ~150 MiB download nobody told the user about. Every lease, `reticle verify`, `open` and `drive`
 * then refused with "Chromium is not installed for Playwright. Run: npx playwright@… install
 * chromium" — the first run stopped on a human step a machine could do. Most machines already have
 * a Chrome or an Edge, and Playwright drives either through `channel`, so that is tried before any
 * download; only a machine with neither gets the pinned install, run for them and announced.
 *
 * Announcements go to STDERR, never stdout: `reticle mcp` speaks JSON-RPC on stdout and one stray
 * line there corrupts the client's stream.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromiumLaunchOptions, type ChromiumLaunchOptions } from './chromium-launch-options.js';
import {
  bundledPlaywrightVersion,
  chromiumInstallCommand,
  chromiumPathProblem,
  configuredChromiumPath,
  configuredChromiumProbe,
  configuredChromiumRefusal,
  probeChromium,
  type ChromiumPathProblem,
  type ChromiumProbe,
} from './command/cli/doctor/browser/chromium-hint.js';

/** The installed-browser channels Playwright can drive in place of its own build. */
export const ChromiumChannel = {
  CHROME: 'chrome',
  MSEDGE: 'msedge',
} as const;
export type ChromiumChannel = (typeof ChromiumChannel)[keyof typeof ChromiumChannel];

/** Tried in this order: Chrome is the likelier install and the closer match to Playwright's build. */
const CHANNEL_ORDER: readonly ChromiumChannel[] = [ChromiumChannel.CHROME, ChromiumChannel.MSEDGE];

export const CHANNEL_LABEL: Record<ChromiumChannel, string> = {
  [ChromiumChannel.CHROME]: 'Google Chrome',
  [ChromiumChannel.MSEDGE]: 'Microsoft Edge',
};

/**
 * Where each channel's executable lives, per platform — the same locations Playwright's own
 * registry checks when it launches a channel, so "we found it" and "Playwright can launch it" agree.
 * Windows is relative to each install root below.
 */
const CHANNEL_PATHS: Record<ChromiumChannel, { darwin: string; linux: string; win32: string }> = {
  [ChromiumChannel.CHROME]: {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/opt/google/chrome/chrome',
    win32: '\\Google\\Chrome\\Application\\chrome.exe',
  },
  [ChromiumChannel.MSEDGE]: {
    darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    linux: '/opt/microsoft/msedge/msedge',
    win32: '\\Microsoft\\Edge\\Application\\msedge.exe',
  },
};

const WINDOWS_INSTALL_ROOTS = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)'] as const;

/** Candidate executable paths for a channel on this platform; empty where it is not installable. */
export function channelExecutableCandidates(
  channel: ChromiumChannel,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const paths = CHANNEL_PATHS[channel];
  if ('darwin' === platform) return [paths.darwin];
  if ('linux' === platform) return [paths.linux];
  if ('win32' === platform) {
    return WINDOWS_INSTALL_ROOTS.flatMap((key) => {
      const root = env[key];
      return root === undefined || 0 === root.length ? [] : [`${root}${paths.win32}`];
    });
  }
  return [];
}

/** The first installed Chrome/Edge on this machine, or undefined. Looks only; installs nothing. */
export function findInstalledChannel(
  deps: Pick<ChromiumTargetDeps, 'exists' | 'platform' | 'env'>,
): ChromiumChannel | undefined {
  return CHANNEL_ORDER.find((channel) =>
    channelExecutableCandidates(channel, deps.platform, deps.env).some((p) => deps.exists(p)),
  );
}

/** Everything the resolver touches, injected so it runs against a fake machine in tests. */
export interface ChromiumTargetDeps {
  /** Where the bundled playwright expects its Chromium build. */
  executablePath: () => string;
  exists: (path: string) => boolean;
  /** What stops the executable RETICLE_CHROMIUM_PATH names from launching, if anything. */
  pathProblem: (path: string) => ChromiumPathProblem | undefined;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Run the pinned Chromium install; resolves true when it succeeded. */
  install: () => Promise<boolean>;
  /** A progress line for a human — stderr in production. */
  announce: (line: string) => void;
}

/**
 * Which browser to launch: the bundled build (no channel), an installed channel, the executable
 * RETICLE_CHROMIUM_PATH names, or none at all. `unusableConfigured` is a named executable that
 * cannot be launched, and why.
 */
export type ChromiumTarget =
  | { found: true; channel?: ChromiumChannel; executablePath?: string }
  | { found: false; unusableConfigured?: { path: string; problem: ChromiumPathProblem } };

const usingChannelLine = (channel: ChromiumChannel): string =>
  `[reticle] Playwright's Chromium is not installed; using the installed ${CHANNEL_LABEL[channel]} instead.\n`;

const installingLine = (command: string): string =>
  `[reticle] No Chromium, Chrome or Edge found; installing Playwright's Chromium (${command}) — a one-time download…\n`;

const INSTALL_FAILED_LINE = '[reticle] The Chromium install did not complete.\n';

/**
 * Decide which browser a launch will use, installing the pinned Chromium only as the last resort.
 * Order: RETICLE_CHROMIUM_PATH → bundled build on disk → installed Chrome → installed Edge →
 * install, then bundled.
 *
 * A named executable ends the search either way. It is set on a machine where the usual places are
 * empty or unusable, so falling back from a typo to a download would only hide the typo.
 */
export async function resolveChromiumTarget(deps: ChromiumTargetDeps): Promise<ChromiumTarget> {
  const configured = configuredChromiumPath(deps.env);
  if (configured !== undefined) {
    const problem = deps.pathProblem(configured);
    return problem === undefined
      ? { found: true, executablePath: configured }
      : { found: false, unusableConfigured: { path: configured, problem } };
  }
  let bundled: string;
  try {
    bundled = deps.executablePath();
  } catch {
    // A playwright that cannot name its executable is not evidence the browser is missing. Launch
    // as before and let Playwright's own error (translated by chromiumLaunchHint) say what is wrong,
    // rather than download ~150 MiB on a guess.
    return { found: true };
  }
  if (deps.exists(bundled)) return { found: true };
  const channel = findInstalledChannel(deps);
  if (channel !== undefined) {
    deps.announce(usingChannelLine(channel));
    return { found: true, channel };
  }
  deps.announce(installingLine(chromiumInstallCommand(bundledPlaywrightVersion())));
  const ok = await deps.install();
  if (ok && deps.exists(bundled)) return { found: true };
  deps.announce(INSTALL_FAILED_LINE);
  return { found: false };
}

/**
 * The bundled playwright's own CLI, or undefined when playwright cannot be resolved from here.
 *
 * Run directly rather than through the `npx playwright@<version>` the hint prints. They install the
 * same revision, but `npx` runs in the user's project and inherits everything wrong with it: in the
 * sandbox this was written against, an `overrides` block in the app's package.json made npm refuse
 * with EOVERRIDE before playwright ever ran. The bundled CLI is the same version by construction
 * and needs no registry round trip to find itself.
 */
function bundledPlaywrightCli(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve('playwright/package.json');
    return join(dirname(pkg), PLAYWRIGHT_CLI);
  } catch {
    return undefined;
  }
}

const PLAYWRIGHT_CLI = 'cli.js';
const INSTALL_ARGS = ['install', 'chromium'] as const;

/**
 * Run the pinned install with its progress on stderr. Memoized per process: the pool can race
 * several launches on the first acquire, and two concurrent installs into one browsers root would
 * fight over the same directory. A failed install clears the memo so a later launch can retry.
 */
let installing: Promise<boolean> | undefined;
function installPinnedChromium(): Promise<boolean> {
  if (installing === undefined) {
    const cli = bundledPlaywrightCli();
    installing = new Promise<boolean>((resolve) => {
      if (cli === undefined) {
        resolve(false);
        return;
      }
      // stdout goes to fd 2 for the JSON-RPC reason in this file's header.
      const child = spawn(process.execPath, [cli, ...INSTALL_ARGS], { stdio: ['ignore', 2, 2] });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(0 === code));
    }).then((ok) => {
      if (!ok) installing = undefined;
      return ok;
    });
  }
  return installing;
}

/** The subset of Playwright's `BrowserType` this file needs, so tests can pass a fake. */
export interface LaunchableChromium<B> {
  executablePath: () => string;
  launch: (options: ChromiumLaunchOptions) => Promise<B>;
}

/**
 * A progress writer that says each distinct line once. The Chrome/Edge fallback line was written on
 * every launch, and the pool launches per context, so one daemon repeated the same notice into the
 * terminal of whoever started it.
 */
export function announceOnce(write: (line: string) => void): (line: string) => void {
  const said = new Set<string>();
  return (line) => {
    if (said.has(line)) return;
    said.add(line);
    write(line);
  };
}

/** Once per PROCESS, so it is shared by every launch rather than made per call. */
// ponytail: an install retried after a failure is not re-announced; the install itself still runs.
const announceToStderr = announceOnce((line) => {
  process.stderr.write(line);
});

function defaultDeps(chromium: { executablePath: () => string }): ChromiumTargetDeps {
  return {
    executablePath: () => chromium.executablePath(),
    exists: existsSync,
    pathProblem: (path) => chromiumPathProblem(path, process.platform),
    platform: process.platform,
    env: process.env,
    install: installPinnedChromium,
    announce: announceToStderr,
  };
}

/**
 * Launch a Chromium with the shared options, on whichever browser this machine can offer. When none
 * can be found or installed, launch anyway: Playwright's own error is what `chromiumLaunchHint`
 * turns into the pinned install command, so the user still gets the one line that fixes it.
 */
export async function launchChromium<B>(
  chromium: LaunchableChromium<B>,
  headless: boolean,
  deps: ChromiumTargetDeps = defaultDeps(chromium),
): Promise<B> {
  const target = await resolveChromiumTarget(deps);
  // Refused here rather than launched: Playwright's error for a missing executable is the one
  // `chromiumLaunchHint` answers with the install command, which cannot fix a wrong path.
  if (!target.found && target.unusableConfigured !== undefined) {
    const { path, problem } = target.unusableConfigured;
    throw new Error(configuredChromiumRefusal(path, problem));
  }
  return target.found
    ? chromium.launch(chromiumLaunchOptions(headless, target.channel, target.executablePath))
    : chromium.launch(chromiumLaunchOptions(headless));
}

/** What the probes read off the machine, injected so a test can name a browser that is not there. */
interface ProbeMachine {
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  pathProblem: (path: string) => ChromiumPathProblem | undefined;
}

const THIS_MACHINE: ProbeMachine = {
  env: process.env,
  exists: existsSync,
  pathProblem: (path) => chromiumPathProblem(path, process.platform),
};

/**
 * The lease preflight's probe: "can a launch succeed?", which now includes the Chrome/Edge fallback
 * and the automatic install. Without this the preflight would refuse a lease on a machine the
 * launcher itself could serve. Falls back to the plain probe so a real refusal keeps its evidence.
 */
export async function probeLaunchableChromium(
  machine: ProbeMachine = THIS_MACHINE,
): Promise<ChromiumProbe> {
  const configured = configuredChromiumProbe(machine.env, machine.pathProblem);
  if (configured !== undefined) return configured;
  try {
    const { chromium } = await import('playwright');
    const target = await resolveChromiumTarget(defaultDeps(chromium));
    if (target.found) return { exists: true };
  } catch {
    // No playwright at all — probeChromium below says so, with where it looked.
  }
  return probeChromium();
}

/**
 * `doctor`'s probe: the plain Chromium probe, plus the installed browser that stands in when the
 * bundled build is missing. Never installs — a diagnostic that downloads 150 MiB is not one.
 */
export async function probeChromiumWithFallback(
  machine: ProbeMachine = THIS_MACHINE,
): Promise<ChromiumProbe> {
  const configured = configuredChromiumProbe(machine.env, machine.pathProblem);
  if (configured !== undefined) return configured;
  const probe = await probeChromium();
  if (probe.exists) return probe;
  const channel = findInstalledChannel({
    exists: machine.exists,
    platform: process.platform,
    env: machine.env,
  });
  return channel === undefined ? probe : { ...probe, fallback: CHANNEL_LABEL[channel] };
}
