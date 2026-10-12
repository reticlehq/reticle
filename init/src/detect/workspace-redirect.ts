/**
 * Workspace redirect: when `init` is run at a monorepo ROOT, wire the app rather than the root.
 *
 * Its own module because it answers a single, separable question: is the app somewhere else, and
 * where?
 *
 * `runInit` arrives as a parameter rather than an import: re-entering init is the whole point of a
 * redirect, and taking it as an argument keeps this module a leaf instead of forming a cycle with
 * the file it was cut from.
 */

import { join } from 'node:path';
import { detect, Framework } from './detect.js';
import { detectNonJsEcosystem, noPackageJsonMessage } from './non-js-project.js';
import {
  findAppsBelow,
  findWorkspaceApps,
  PACKAGE_JSON,
  workspacePackageDirs,
} from './workspace-apps.js';
import { projectIdOf, RETICLE_CONFIG_FILE } from './existing-config.js';
import { chooseWorkspaceApp, withoutTrailingSlashes } from './declared/app-choice.js';
import type { InitIo, InitOptions, InitResult } from '@/run-types.js';

/** Re-enter `init`, scoped to one directory of the workspace. */
type RunInit = (options: InitOptions, io: InitIo) => InitResult;

const ROOT_CONFIG_LEAD = `This root's ${RETICLE_CONFIG_FILE} names`;

/**
 * The one workspace package whose `.reticle.json` carries the project the root's does.
 *
 * The root config is a copy of the app's (see `agentRootConfigStep`), so the projectId is what ties
 * the two together; no path is stored. Searched across every package directory rather than the
 * discovered apps, because the app `--app` named is the app whether or not discovery would list it.
 */
function appNamedByRootConfig(io: InitIo): string | undefined {
  const wanted = projectIdOf(io.readFile(RETICLE_CONFIG_FILE));
  if (wanted === undefined) return undefined;
  const named = workspacePackageDirs(io).filter(
    (dir) => projectIdOf(io.readFile(`${dir}/${RETICLE_CONFIG_FILE}`)) === wanted,
  );
  return 1 === named.length ? named[0] : undefined;
}

const AMBIGUOUS_HEADER =
  'Several apps found in this workspace. Re-run `reticle init` for the one you want:';
const BELOW_HEADER =
  'No app in this folder. Several below it; re-run `reticle init` for the one you want:';
const HOME_HEADER =
  'This is your home folder, so init wires nothing on its own here. Apps found below it; run one:';
const STATIC_PAGE = 'index.html';

/** The folder `init` was run in is the person's home: a place to find apps, never to wire one. */
function inHome(io: InitIo): boolean {
  const trim = (p: string): string => withoutTrailingSlashes(p.replace(/\\/g, '/'));
  return trim(io.cwd()) === trim(io.homeDir());
}

/** Print the candidates as commands to paste, and stop: the choice is the person's. */
function listApps(io: InitIo, header: string, apps: readonly string[]): InitResult {
  io.print(header);
  for (const a of apps) {
    const displayed = displayedWorkspaceAppCommand(a, process.platform);
    if (displayed.label !== undefined) io.print(`  ${displayed.label}`);
    io.print(`  ${displayed.command}`);
  }
  return { ok: false, applied: 0, manual: apps.length, listedAppsBelow: true };
}

const WORKSPACE_APP_COMMAND = 'reticle init --app';
const ALREADY_WIRED = 'Already wired here:';
const WIRE_ANOTHER = 'To wire another app:';
const POWERSHELL_ONLY_LABEL = 'PowerShell only:' as const;
const PLAIN_SHELL_ARG = /^[A-Za-z0-9_./-]+$/;

interface DisplayedWorkspaceAppCommand {
  command: string;
  label?: typeof POWERSHELL_ONLY_LABEL;
}

function posixShellArg(arg: string): string {
  return `'${arg.replaceAll("'", "'\"'\"'")}'`;
}

function powerShellArg(arg: string): string {
  return `'${arg.replaceAll("'", "''")}'`;
}

/**
 * Render one discovered workspace app as a command the user can paste back into a shell.
 *
 * Plain paths need no quoting. Complex Windows paths are explicitly PowerShell-only because
 * cmd.exe and PowerShell use different quoting grammars.
 */
export function displayedWorkspaceAppCommand(
  app: string,
  platform: NodeJS.Platform,
): DisplayedWorkspaceAppCommand {
  if (PLAIN_SHELL_ARG.test(app)) {
    return { command: `${WORKSPACE_APP_COMMAND} ${app}` };
  }

  if ('win32' === platform) {
    return {
      label: POWERSHELL_ONLY_LABEL,
      command: `${WORKSPACE_APP_COMMAND} ${powerShellArg(app)}`,
    };
  }

  return {
    command: `${WORKSPACE_APP_COMMAND} ${posixShellArg(app)}`,
  };
}

/**
 * When the current directory is a workspace root with no app of its own, wire the app instead of the
 * root. One candidate is wired silently (there is nothing to ask about); several are listed, because
 * guessing which app someone meant is worse than one line of output.
 * Returns null when there is nothing to redirect to — the caller then proceeds here as before.
 */
export function redirectToWorkspaceApp(
  options: InitOptions,
  io: InitIo,
  pkg: unknown,
  runInit: RunInit,
): InitResult | null {
  if (true === options.redirected) return null;
  const rootFiles = new Set(io.rootFiles());
  const here = detect({
    pkg: 'object' === typeof pkg && pkg !== null ? pkg : {},
    configFiles: rootFiles,
    lockfiles: new Set(),
  });
  // `--app` is an INSTRUCTION, and it is read before the guess below. The guess answers "where is
  // the app?" for somebody who did not say; when somebody said, there is nothing left to infer.
  //
  // Read BEFORE the check underneath, which returns early for any directory that looks like an app —
  // which a JS monorepo ROOT does, because shared tooling puts `vite` in its devDependencies. Read
  // after, `reticle init --app packages/player` silently ignored the flag on a pnpm+turbo monorepo:
  // it installed the SDK into the root's package.json, wrote `.reticle.json` and `src/reticle-dev.ts`
  // into a repository root that has no `src/`, left the named app untouched, and reported success.
  //
  // Existence is the test, not membership of the discovered list: discovery scans conventional
  // directories, and somebody who names a path knows their own layout better than the scan does.
  const named = options.app === undefined || '' === options.app ? undefined : options.app;
  if (named !== undefined) {
    const wanted = withoutTrailingSlashes(named);
    // A plain page is an app too: `init` wires its index.html once it is standing in that folder.
    if (io.exists(`${wanted}/${PACKAGE_JSON}`) || io.exists(`${wanted}/${STATIC_PAGE}`))
      return enterApp(options, io, wanted, 'Wiring', runInit);
    const inWanted = (file: string): boolean => io.exists(`${wanted}/${file}`);
    io.print(
      detectNonJsEcosystem(inWanted) === undefined
        ? `--app ${named} does not name a directory with a package.json in it.`
        : noPackageJsonMessage(inWanted),
    );
    return { ok: false, applied: 0, manual: 1 };
  }
  if (here.framework !== Framework.HTML) return null; // this directory IS the app

  // A root that an earlier `--app` run (or a run inside the app) already pointed at one app has
  // answered the question discovery would ask. Ignoring it made every re-run at the root refuse
  // again with the same list, and exit 1 over a setup that had worked.
  const pointed = appNamedByRootConfig(io);
  if (pointed !== undefined) return enterApp(options, io, pointed, ROOT_CONFIG_LEAD, runInit);

  const apps = findWorkspaceApps(io);
  // An explicitly named app answers the ambiguity. Refusing to guess is right, but "re-run inside the
  // one you want" is not something a script, a CI step, or an agent that cannot change directory can
  // act on — so the refusal was a dead end for exactly the callers most likely to hit it.
  const chosen = chooseWorkspaceApp(options.app, apps);
  if (!chosen.ok) {
    io.print(chosen.message);
    return { ok: false, applied: 0, manual: 1 };
  }
  // A home folder holds every project the person has; picking one for them is a guess.
  if (chosen.app === undefined && inHome(io)) {
    const found = 0 < apps.length ? apps : findAppsBelow(io);
    return 0 < found.length ? listApps(io, HOME_HEADER, found) : null;
  }
  // No app one or two levels down and no manifest here: look deeper before giving up, so a repo
  // whose web app sits at `client/web/app`, or a bare page in `site/`, is wired rather than refused.
  if (0 === apps.length && !io.exists(PACKAGE_JSON) && chosen.app === undefined) {
    const below = findAppsBelow(io);
    if (1 === below.length && below[0] !== undefined)
      return enterApp(options, io, below[0], 'No app in this directory — wiring', runInit);
    if (1 < below.length) return listApps(io, BELOW_HEADER, below);
  }
  const target = chosen.app ?? (1 === apps.length ? apps[0] : undefined);
  if (target === undefined) {
    if (0 === apps.length) return null; // not a workspace — fall through to the normal HTML plan
    // Apps already wired answer a re-run here: nothing to do at the root, which is pinned to none.
    const wired = apps.filter((a) => io.exists(`${a}/${RETICLE_CONFIG_FILE}`));
    io.print(0 === wired.length ? AMBIGUOUS_HEADER : `${ALREADY_WIRED} ${wired.join(', ')}.`);
    const rest = apps.filter((a) => !wired.includes(a));
    if (0 < wired.length && 0 < rest.length) io.print(WIRE_ANOTHER);
    for (const a of 0 === wired.length ? apps : rest) {
      const displayed = displayedWorkspaceAppCommand(a, process.platform);
      if (displayed.label !== undefined) io.print(`  ${displayed.label}`);
      io.print(`  ${displayed.command}`);
    }
    return 0 === wired.length
      ? { ok: false, applied: 0, manual: apps.length }
      : { ok: true, applied: 0, manual: 0 };
  }
  return enterApp(options, io, target, 'No app in this directory — wiring', runInit);
}

/**
 * Re-enter `init` scoped to one directory of a workspace.
 *
 * One implementation for both routes in — the app somebody NAMED and the app discovery found when
 * nobody did. They differ only in the sentence printed; scoping the io, moving the cwd and keeping
 * the agent root has to be identical for both, and was worth having twice for exactly as long as it
 * took to get one of them wrong.
 */
function enterApp(
  options: InitOptions,
  io: InitIo,
  target: string,
  lead: string,
  runInit: RunInit,
): InitResult {
  io.print(`${lead} ${target}.`);
  io.print('');
  return runInit(
    {
      ...options,
      cwd: join(options.cwd, target),
      redirected: true,
      // Where the human is STANDING, kept across the redirect: their agent session runs here, so
      // this is the only place a `/reticle` command file can be found by it.
      agentRoot: options.agentRoot ?? options.cwd,
      severalApps: true === options.severalApps || 1 < findWorkspaceApps(io).length,
    },
    io.scoped(target),
  );
}
