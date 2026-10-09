/**
 * The self-update command pair — `reticle update` and `reticle rollback`.
 *
 * Split out of cli.ts, which sits at the 600-line cap: these two are one cohesive unit (swap the
 * installed version, restart) and the file they came from is the CLI's dispatch table, which grows
 * for entirely different reasons.
 */
import { checkForUpdate } from '@/command/update/update-checker.js';
import { isNewerVersion, updateTarget } from '@/command/update/update-nudge.js';
import { applyUpdate, rollback } from '@/command/update/updater.js';
import {
  refreshAgentRules,
  detectPackageManager,
  buildNodeIo,
  enclosingWorkspaceRoot,
  SILENT_HOST,
} from '@reticlehq/init';
import { SERVER_VERSION } from '@/command/version/identity/server-version.js';
import { log } from '@/log.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { reticleDepsOf, sdkSyncCommand } from '@/command/update/sdk-sync.js';
import { installedSdkVersion, readTextFile } from '@/command/cli/launch/sdk-version-match.js';

const WINDOWS_MANUAL_UPDATE =
  'irm https://raw.githubusercontent.com/reticlehq/reticle/main/install/install.ps1 | iex';

/**
 * What a person reads. `log` lines are JSON on stderr for the daemon's log, and a human running
 * `reticle update` in a terminal used to see nothing else — not even that the restart was theirs.
 */
const MSG_SDK_SYNCED = (version: string): string =>
  `Updated this app's Reticle SDK to ${version}. Now restart your dev server and reload the tab: ` +
  'a running dev server keeps serving the old SDK, overlay included.';
const MSG_SDK_SYNC_FAILED = (command: string): string =>
  `Could not update this app's Reticle SDK. Run \`${command}\`, then restart your dev server.`;
const MSG_SDK_LINKED =
  'This app links its Reticle packages locally, so `reticle update` leaves them as they are.';
/** Dependency specs that point at a local copy, not the registry: rewriting one to a pin breaks it. */
const LOCAL_SPEC = /^(workspace|link|file|portal):/;

function linksLocally(manifest: unknown, packages: readonly string[]): boolean {
  if ('object' !== typeof manifest || null === manifest) return false;
  const m = manifest as Record<string, unknown>;
  return packages.some((name) =>
    ['dependencies', 'devDependencies'].some((field) => {
      const deps = m[field];
      if ('object' !== typeof deps || null === deps) return false;
      const spec = (deps as Record<string, unknown>)[name];
      return 'string' === typeof spec && LOCAL_SPEC.test(spec);
    }),
  );
}
const MSG_NO_SDK_HERE =
  "No Reticle SDK in this folder, so only the CLI was checked. Run `reticle update` in your app's " +
  'folder to bring its SDK up too.';

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Bring the SDK in the CURRENT project to the version being installed.
 *
 * Best-effort and non-fatal on purpose: `reticle update` is run from wherever the human happens to
 * be, which is often not an app at all. A directory with no manifest, or one that has none of our
 * packages, simply has nothing to sync — that is a normal outcome, not a failure, and it must never
 * stop the CLI half from happening.
 */
function syncProjectSdk(target: string, cwd: string): void {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    say(MSG_NO_SDK_HERE);
    return; // not an app directory
  }
  const packages = reticleDepsOf(manifest);
  if (linksLocally(manifest, packages)) {
    say(MSG_SDK_LINKED);
    return;
  }
  // Nothing to trace and nothing to report: this reads the manifest and runs one package-manager
  // command. It never enters `runInit`, so there is no init outcome for a host to carry.
  const io = buildNodeIo(cwd, SILENT_HOST);
  // A workspace member keeps its lockfile at the workspace root: read both, or an app in a pnpm
  // workspace looks lockfile-less and is installed with npm.
  const workspace = enclosingWorkspaceRoot(cwd, io);
  const rootIo = workspace === undefined ? io : buildNodeIo(workspace, SILENT_HOST);
  const pm = detectPackageManager(
    new Set([...io.rootFiles(), ...rootIo.rootFiles()]),
    new Set([...io.listDirs('node_modules'), ...rootIo.listDirs('node_modules')]),
  );
  const cmd = sdkSyncCommand(pm, packages, target);
  if (null === cmd) {
    log('reticle_update_sdk', { synced: false, reason: 'no @reticlehq packages in this project' });
    say(MSG_NO_SDK_HERE);
    return;
  }
  const ok = io.exec(cmd.command, cmd.args);
  log('reticle_update_sdk', { synced: ok, packages, to: target, packageManager: pm });
  if (!ok) {
    const line = `${cmd.command} ${cmd.args.join(' ')}`;
    log('reticle_update_sdk_failed', {
      hint: `run \`${line}\` by hand, then restart the dev server`,
    });
    say(MSG_SDK_SYNC_FAILED(line));
    return;
  }
  say(MSG_SDK_SYNCED(target));
}

/** `reticle update` — install the latest server version, sync the app's SDK, and restart. */
export async function handleUpdate(cwd: string = process.cwd()): Promise<void> {
  try {
    const manifest = await checkForUpdate(SERVER_VERSION, () => Date.now());
    // Direction, not inequality: the registry being DIFFERENT is not the registry being newer, and
    // the old gate happily installed a downgrade — reported by a user. See updateTarget.
    const target = updateTarget(manifest);
    if (target === undefined) {
      // The CLI being current says nothing about the app. A CLI from the installer or a fresh npx
      // is on the latest release while the app keeps the SDK `init` pinned months ago, and this
      // branch used to return before the sync — so the one command that should fix that pair
      // answered "already on the latest version" and left the old overlay in the page.
      const installed = installedSdkVersion(cwd, readTextFile);
      if (installed === undefined) say(MSG_NO_SDK_HERE);
      // Only UP. A CLI that could not reach the registry also lands here, and an older one must
      // never pin a newer app back to itself.
      else if (isNewerVersion(SERVER_VERSION, installed)) syncProjectSdk(SERVER_VERSION, cwd);
      log('reticle_update', {
        ok: false,
        message: 'already on the latest version',
        version: SERVER_VERSION,
      });
      return;
    }
    log('reticle_update', { ok: true, from: SERVER_VERSION, to: target });
    // Bring this project's agent rules up with the version.
    //
    // The managed block has always been updatable — marker-delimited, idempotent by comparing
    // content — and nothing called it after the first install. `mergeMarkedInstruction` is reachable
    // from `buildPlan` alone, so a project set up on an older release kept that release's
    // instructions forever and every improvement to them reached new projects only.
    //
    // That is backwards: the people who most need better instructions are the ones already
    // installed and not getting value, and this is the moment they are touching the install anyway.
    // Only files that ALREADY carry the block are touched, and only inside the markers.
    const refreshed = refreshAgentRules(cwd, {
      read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
      write: (path, content) => {
        writeFileSync(path, content, 'utf8');
      },
    });
    if (0 !== refreshed.updated.length)
      log('reticle_rules_refreshed', { files: refreshed.updated, to: target });
    // The app's SDK FIRST, then the CLI. `reticle update` used to swap only the CLI, so the command
    // whose job is keeping an install current was itself a way to produce a version-skewed pair —
    // and the skew message told people to run it to fix an outdated SDK, which it could not do.
    //
    // Before the CLI swap because `applyUpdate` never returns (it execs and exits). If this half
    // fails the daemon is still the older one, which is the direction the HELLO check names clearly
    // and a re-run fixes; the reverse would leave a new daemon talking to an old page.
    syncProjectSdk(target, cwd);
    await applyUpdate(target); // calls process.exit; Claude Code restarts
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('reticle_update_failed', {
      error: message,
      ...('win32' === process.platform && message.includes('spawn EINVAL')
        ? { hint: `run \`${WINDOWS_MANUAL_UPDATE}\` in PowerShell to update manually` }
        : {}),
    });
    process.exitCode = 1;
  }
}

/** `reticle rollback` — restore the previous server version and restart. */
export async function handleRollback(): Promise<void> {
  try {
    await rollback(); // calls process.exit
  } catch (error) {
    log('reticle_rollback_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
