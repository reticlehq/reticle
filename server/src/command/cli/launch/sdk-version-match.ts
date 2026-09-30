/**
 * Run the CLI whose major matches the SDK the project actually installed.
 *
 * The agent's MCP entry and every rule file `init` writes say `npx @reticlehq/server`, deliberately
 * unpinned (see `npxServerArgs` in init), which resolves the LATEST server — while the project's SDK
 * stays locked at whatever `init` installed. A project wired on the previous major therefore got a
 * daemon from the next one, and every verdict came back `version_skew`; a global install from an
 * older release shadows npx the same way in the other direction. Nothing the project could do fixed
 * it short of upgrading, and the report named the skew without resolving it.
 *
 * So the one entry every command passes through asks, before doing anything: is the SDK in this
 * project on my major? If not, it hands the same arguments to `npx @reticlehq/server@<that version>`
 * and steps aside. Only across majors — a minor apart verifies fine, and re-running for it would
 * cost an npx resolve on every command for nothing.
 *
 * Deliberately free of `@/` and relative imports: the stdio test runs this file in a bare Node child
 * to see the real file descriptors, and that child has neither the alias nor the build.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NodePlatform, windowsShellArg } from '@reticlehq/init';

/** The packages an instrumented project installs; they release in lockstep, so any one will do. */
export const SDK_PACKAGES = [
  '@reticlehq/react',
  '@reticlehq/browser',
  '@reticlehq/next',
  '@reticlehq/vite-plugin',
] as const;

/** The package that carries the `reticle` bin — what the re-run asks npx for. */
const SERVER_PACKAGE = '@reticlehq/server';
const NPX = 'npx';
const NPX_WINDOWS = 'npx.cmd';
const NPX_YES = '--yes';
const NODE_MODULES = 'node_modules';
const PACKAGE_JSON = 'package.json';
const LATEST_TAG = 'latest';
const MARKED = '1';

export const VersionMatchEnv = {
  /** Set to anything to keep the CLI you ran, whatever the project installed. */
  OPT_OUT: 'RETICLE_NO_VERSION_MATCH',
  /** Set on the re-run child, so it can never re-run itself again. */
  REEXECUTED: 'RETICLE_VERSION_MATCHED',
  /** What npm puts here for `npx <spec>` — how a version typed on the npx line is recognised. */
  NPX_PACKAGE: 'npm_config_package',
} as const;

/**
 * Commands whose job is to CHANGE the version, or to report on this binary. Re-running `init` or
 * `update` at the project's old version would undo exactly what the person asked for; `version` and
 * `help` describe the binary they ran. `_daemon` is spawned by a CLI that already decided.
 */
const KEEP_COMMANDS: ReadonlySet<string> = new Set([
  'init',
  'update',
  'rollback',
  'version',
  'help',
  '_daemon',
]);
const KEEP_FLAGS: ReadonlySet<string> = new Set(['--version', '-v', '--help', '-h']);
const SETUP_COMMAND = 'setup';
const SETUP_INSTALL = 'install';

/** A published release — not `workspace:*`, a link, or a tag npx could not pin. */
const RELEASE_VERSION = /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function majorOf(version: string): string | undefined {
  return RELEASE_VERSION.exec(version)?.[1];
}

/**
 * The SDK version installed for `projectDir`, found the way Node resolves it: the nearest
 * `node_modules` at or above the directory, so a package hoisted to a workspace root counts.
 */
export function installedSdkVersion(
  projectDir: string,
  readFile: (path: string) => string | undefined,
): string | undefined {
  let dir = projectDir;
  for (;;) {
    for (const pkg of SDK_PACKAGES) {
      const raw = readFile(join(dir, NODE_MODULES, pkg, PACKAGE_JSON));
      if (raw === undefined) continue;
      try {
        const version: unknown = (JSON.parse(raw) as { version?: unknown }).version;
        if ('string' === typeof version) return version;
      } catch {
        // A manifest that will not parse is no evidence; try the next package.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `readFile` for the real filesystem: the text, or undefined when there is nothing readable. */
export function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The one line a person sees on stderr when the CLI hands over — stdout belongs to the protocol. */
export function versionMatchNote(sdkVersion: string, cliVersion: string): string {
  return (
    `This project's Reticle SDK is ${sdkVersion}; running ${SERVER_PACKAGE}@${sdkVersion} to match ` +
    `(this CLI is ${cliVersion}, a different major). Set ${VersionMatchEnv.OPT_OUT}=1 to keep this one.`
  );
}

/** Did the person name a version on the npx line (`npx @reticlehq/server@<version> …`)? */
function pinnedOnNpxLine(spec: string | undefined): boolean {
  if (spec === undefined || !spec.startsWith(`${SERVER_PACKAGE}@`)) return false;
  return spec.slice(SERVER_PACKAGE.length + 1) !== LATEST_TAG;
}

function keepsThisBinary(argv: readonly string[]): boolean {
  const [command, sub] = argv;
  if (command !== undefined && KEEP_COMMANDS.has(command)) return true;
  if (SETUP_COMMAND === command && SETUP_INSTALL === sub) return true;
  return argv.some((arg) => KEEP_FLAGS.has(arg));
}

export interface VersionMatchInput {
  argv: readonly string[];
  cliVersion: string;
  env: Readonly<Record<string, string | undefined>>;
  projectDir: string;
  readFile: (path: string) => string | undefined;
}

/**
 * The version to re-run at, or undefined to carry on in this process. Pure: the filesystem and the
 * environment are handed in.
 */
export function versionToMatch(input: VersionMatchInput): string | undefined {
  const { env } = input;
  if (env[VersionMatchEnv.REEXECUTED] !== undefined) return undefined;
  if (env[VersionMatchEnv.OPT_OUT] !== undefined) return undefined;
  if (pinnedOnNpxLine(env[VersionMatchEnv.NPX_PACKAGE])) return undefined;
  if (keepsThisBinary(input.argv)) return undefined;
  const sdk = installedSdkVersion(input.projectDir, input.readFile);
  if (sdk === undefined) return undefined;
  const sdkMajor = majorOf(sdk);
  if (sdkMajor === undefined) return undefined;
  return sdkMajor === majorOf(input.cliVersion) ? undefined : sdk;
}

/** How to launch `npx --yes @reticlehq/server@<version> <args>` on this platform. */
export function npxInvocation(
  version: string,
  args: readonly string[],
  on: string,
): { file: string; argv: string[]; shell: boolean } {
  const argv = [NPX_YES, `${SERVER_PACKAGE}@${version}`, ...args];
  // A `.cmd` cannot be spawned without a shell since the CVE-2024-27980 fix, and a shell needs every
  // argument quoted — the same rule `npmSpawn` in the updater follows.
  if (NodePlatform.WINDOWS !== on) return { file: NPX, argv, shell: false };
  return { file: [NPX_WINDOWS, ...argv.map(windowsShellArg)].join(' '), argv: [], shell: true };
}

/** The two things the re-run needs from its child: when it ends, and a way to pass a signal on. */
export interface ReexecChild {
  /** Called once, with the exit code — or undefined when the child never started or was killed. */
  onEnd(listener: (code: number | undefined, error: Error | undefined) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export type ReexecSpawner = (
  file: string,
  argv: string[],
  options: { stdio: 'inherit'; env: NodeJS.ProcessEnv; shell: boolean },
) => ReexecChild;

/** A ChildProcess, seen through `ReexecChild`. */
export function asReexecChild(child: ChildProcess): ReexecChild {
  return {
    onEnd: (listener) => {
      // Node can emit `error` AND `exit` for one child; the listener exits the process, so once.
      let ended = false;
      const end = (code: number | undefined, error: Error | undefined): void => {
        if (ended) return;
        ended = true;
        listener(code, error);
      };
      child.once('error', (error) => end(undefined, error));
      child.once('exit', (code) => end(code ?? undefined, undefined));
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

/** The real spawner. */
export const nodeSpawner: ReexecSpawner = (file, argv, options) =>
  asReexecChild(spawn(file, argv, options));

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SPAWN_FAILED_EXIT = 1;

/**
 * Hand this invocation to the matching version and exit with its code.
 *
 * `stdio: 'inherit'` gives the child this process's own file descriptors, so an MCP client's JSON-RPC
 * stream reaches it without passing through a byte of JavaScript here — nothing to buffer, reframe or
 * lose. For that to hold, this must run before anything writes to stdout.
 */
export function reexecAtVersion(
  version: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: {
    spawn: ReexecSpawner;
    exit: (code: number) => void;
    platform?: string;
    warn?: (line: string) => void;
  },
): void {
  const inv = npxInvocation(version, args, deps.platform ?? process.platform);
  const child = deps.spawn(inv.file, inv.argv, {
    stdio: 'inherit',
    env: { ...env, [VersionMatchEnv.REEXECUTED]: MARKED },
    shell: inv.shell,
  });
  // A client that stops the proxy signals THIS pid; the real server is the child.
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  child.onEnd((code, error) => {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
    if (error !== undefined) {
      deps.warn?.(
        `Could not start ${SERVER_PACKAGE}@${version} to match this project's SDK (${error.message}). ` +
          `Set ${VersionMatchEnv.OPT_OUT}=1 to use the installed CLI instead.`,
      );
    }
    deps.exit(code ?? SPAWN_FAILED_EXIT);
  });
}
