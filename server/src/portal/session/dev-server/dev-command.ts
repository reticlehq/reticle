/**
 * The literal command that starts THIS project's dev server, read from the project's own scripts.
 *
 * The no-session diagnosis has always said "ask the human to start it (`npm run dev`)". That is a
 * guess on two axes — the script name and the package manager — and a guessed command is worse than
 * none: the agent runs it, gets an error about a missing script, and concludes the app is broken
 * rather than that Reticle was wrong. So this reads, and returns nothing when it cannot read.
 *
 * Pure apart from one injected reader, so every case is a unit test rather than a temp directory.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { desktopLaunch, workspacePackageDirs } from '@reticlehq/init';

/** A dev script, as something an agent can actually run. */
export interface DevCommand {
  /** The literal shell command, e.g. `pnpm run dev`. */
  command: string;
  /** The package.json script it runs. Absent when the command runs a CLI directly (`npx tauri dev`). */
  script?: string;
  /** The port the script PINS, when it pins one. Absent means the tool picks — never a guess. */
  port?: number;
  /** The app's directory, when it is not the project root. The caller must run the command there. */
  directory?: string;
}

/**
 * Script names checked, in order.
 *
 * `start` is last on purpose: in a Next or CRA app it is the PRODUCTION server, which serves a build
 * with no dev-only SDK in it, so starting it would look like success and connect nothing. It is only
 * reached when the project offers nothing better.
 */
const DEV_SCRIPTS = ['dev', 'develop', 'start'] as const;

/** Lockfile → package manager, in precedence order. Anything else is npm. */
const LOCKFILES = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
] as const;

const DEFAULT_PACKAGE_MANAGER = 'npm';
const PACKAGE_JSON = 'package.json';

/** `--port 4311` / `--port=4311`, the flag every dev server in this list accepts. */
const PORT_FLAG = /--port[= ]\s*(\d+)/;
/**
 * `-p 3005`, the short form Next, Nuxt and Astro accept (reticle#1367).
 *
 * Anchored to a start or a whitespace so the `-p` inside a longer flag (`--pretty`) is not a port.
 */
const PORT_SHORT_FLAG = /(?:^|\s)-p\s*(\d+)/;
/** `PORT=8080 remix dev` — the other half of how a project pins its port. */
const PORT_ENV = /(?:^|\s)PORT=(\d+)/;

/** Reads a file, or undefined if it is not there / not readable. */
function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The port the script pins, when it pins one at all. */
function pinnedPort(script: string): number | undefined {
  const match = PORT_FLAG.exec(script) ?? PORT_SHORT_FLAG.exec(script) ?? PORT_ENV.exec(script);
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  const port = Number.parseInt(digits, 10);
  return Number.isSafeInteger(port) ? port : undefined;
}

/** The parsed package.json, or undefined for anything unreadable/unparseable. */
function readManifest(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The scripts block of a parsed package.json, or an empty one. */
function scriptsOf(manifest: unknown): Record<string, unknown> {
  if (null === manifest || 'object' !== typeof manifest) return {};
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (null === scripts || 'object' !== typeof scripts) return {};
  return scripts as Record<string, unknown>;
}

/** The package manager the lockfiles under `directory` identify. Anything else is npm. */
function packageManager(directory: string, read: (path: string) => string | undefined): string {
  return (
    LOCKFILES.find(({ file }) => read(join(directory, file)) !== undefined)?.manager ??
    DEFAULT_PACKAGE_MANAGER
  );
}

/** The dev command for the package in `directory`, with the manager chosen by the caller. */
function devCommandFor(
  directory: string,
  manager: string,
  read: (path: string) => string | undefined,
): DevCommand | undefined {
  const manifest = readManifest(read(join(directory, PACKAGE_JSON)));
  const scripts = scriptsOf(manifest);
  // A desktop shell's `dev` is its renderer's dev server, which no window ever opens onto. init's
  // rule decides which launcher it is, so the command the daemon hands an agent and the one init
  // spawns are the same.
  const desktop = desktopLaunch(manifest);
  if (desktop !== undefined) {
    if ('command' in desktop) return { command: desktop.command };
    const command = `${manager} run ${desktop.script}`;
    return {
      command: 0 < desktop.args.length ? `${command} ${desktop.args}` : command,
      script: desktop.script,
    };
  }
  for (const script of DEV_SCRIPTS) {
    const body = scripts[script];
    if ('string' !== typeof body || 0 === body.trim().length) continue;
    const port = pinnedPort(body);
    return {
      command: `${manager} run ${script}`,
      script,
      ...(port === undefined ? {} : { port }),
    };
  }
  return undefined;
}

/** Directory names under `path`, or none when it cannot be read. */
function readDirNames(path: string): readonly string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The dev command for the project in `directory`, or undefined when there is not one to be sure of.
 *
 * `read` is injected so the whole decision is testable without a filesystem; the daemon uses the
 * default disk reader.
 */
export function detectDevCommand(
  directory: string,
  read: (path: string) => string | undefined = readTextFile,
): DevCommand | undefined {
  return devCommandFor(directory, packageManager(directory, read), read);
}

/**
 * The dev command for the project, looking one level down when the root has none.
 *
 * `reticle init` is run at the repo root, and in a monorepo the app is a directory down — so the
 * daemon's "this project declares no dev script" was false for a root whose `frontend/package.json`
 * held `"dev": "vite"`, and the agent asked a human for a command that was on disk (reticle#1368).
 * init's own workspace listing answers which directories to consider; the root's lockfile picks the
 * package manager, because a workspace package usually has no lockfile of its own.
 */
export function detectDevCommandInProject(
  directory: string,
  read: (path: string) => string | undefined = readTextFile,
  listDirs: (path: string) => readonly string[] = readDirNames,
): DevCommand | undefined {
  const manager = packageManager(directory, read);
  const here = devCommandFor(directory, manager, read);
  if (here !== undefined) return here;
  const packages = workspacePackageDirs({
    readFile: (path) => read(join(directory, path)) ?? null,
    listDirs: (path) => listDirs(join(directory, path)),
  });
  for (const sub of packages) {
    const found = devCommandFor(join(directory, sub), manager, read);
    if (found !== undefined) return { ...found, directory: sub };
  }
  return undefined;
}
