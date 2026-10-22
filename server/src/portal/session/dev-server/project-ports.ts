/**
 * Ports this project uses that its `dev` script does not name (reticle#1543).
 *
 * The no-session scan probes a list of well-known ports, the ports the build plugins announced, a
 * port pinned in the `dev` script (#1367), and the ports of earlier sessions. An app that reads its
 * port from code or from `.env` is on none of those. Reported from React apps on Windows: a preview
 * server on :3020, started by a Node script, and the answer said no app was running and suggested a
 * dev server, which would start a duplicate.
 *
 * Two more sources close most of that gap:
 *
 * - `PORT=` in the project's `.env` files, which is where such a script usually reads its port.
 * - Best effort, the TCP ports that a process whose working directory is inside the project listens
 *   on. This finds a port that no file names. It needs a way to list listeners and their working
 *   directories, so it is off where there is none (Windows) and returns nothing when the probe fails.
 *
 * Both only ADD candidates to the scan. The scan still decides which of them answer like a dev server.
 */

import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { readlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/** The `.env` files a Node dev setup reads, in the order dotenv-style loaders read them. */
export const ENV_PORT_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
] as const;

/** One `PORT=3020` line. `export`, quotes and a trailing comment are allowed. */
const ENV_PORT_LINE = /^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{1,5})["']?\s*(?:#.*)?$/gm;

/** The highest TCP port. */
const MAX_PORT = 65_535;

/** How long one listener or working-directory query may take before the probe gives up. */
const PROBE_TIMEOUT_MS = 2_000;

/** The `lsof` binary both probe queries use. */
const LSOF = 'lsof';

/** `lsof` arguments that list every listening TCP socket, one `p<pid>` then `n<address>` per entry. */
const LSOF_LISTENERS_ARGS = ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'] as const;

/** `lsof` arguments, after `-p <pid>`, that print one process's working directory as `n<path>`. */
const LSOF_CWD_ARGS = ['-a', '-d', 'cwd', '-Fn'] as const;

/** The Linux file whose link target is a process's working directory. */
const PROC_CWD = (pid: number): string => `/proc/${String(pid)}/cwd`;

const PLATFORM_LINUX = 'linux';
const PLATFORM_DARWIN = 'darwin';

/** One listening socket and the process that owns it. */
export interface ProcessListener {
  readonly pid: number;
  readonly port: number;
}

/** The two questions the listener source asks of the system. Injected so a test opens no socket. */
export interface ListenerProbe {
  /** Every listening TCP socket on the machine, with its owning process. */
  listeners(): Promise<readonly ProcessListener[]>;
  /** The working directory of `pid`, or undefined when it cannot be read. */
  cwdOf(pid: number): Promise<string | undefined>;
}

function toPort(digits: string | undefined): number | undefined {
  if (digits === undefined) return undefined;
  const port = Number(digits);
  return Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The ports the project's `.env` files set with `PORT=`.
 *
 * Every file is read, not only the one a given loader would pick: the scan only probes candidates,
 * so an extra port costs one connection attempt, while a missed one is the defect this fixes.
 */
export function envFilePorts(
  directory: string,
  read: (path: string) => string | undefined = readText,
): number[] {
  const ports = new Set<number>();
  for (const file of ENV_PORT_FILES) {
    const text = read(join(directory, file));
    if (text === undefined) continue;
    for (const match of text.matchAll(ENV_PORT_LINE)) {
      const port = toPort(match[1]);
      if (port !== undefined) ports.add(port);
    }
  }
  return [...ports];
}

/** Whether `path` is `root` or inside it. Both are compared as real paths. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return '' === rel || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The ports that processes running inside `directory` listen on.
 *
 * Best effort by design: a probe that throws, or a process whose directory cannot be read, adds
 * nothing. It never removes a candidate the other sources found.
 */
export async function projectListenerPorts(
  directory: string,
  probe: ListenerProbe,
): Promise<number[]> {
  const root = realPath(directory);
  let listeners: readonly ProcessListener[];
  try {
    listeners = await probe.listeners();
  } catch {
    return [];
  }
  const cwdByPid = new Map<number, string | undefined>();
  const ports = new Set<number>();
  for (const { pid, port } of listeners) {
    if (!cwdByPid.has(pid)) {
      const cwd = await probe.cwdOf(pid).catch(() => undefined);
      cwdByPid.set(pid, cwd === undefined ? undefined : realPath(cwd));
    }
    const cwd = cwdByPid.get(pid);
    if (cwd !== undefined && isInside(root, cwd)) ports.add(port);
  }
  return [...ports];
}

/** Parses `lsof -F pn` output: a `p<pid>` line, then one `n<address>` line per socket it owns. */
export function parseLsofListeners(output: string): ProcessListener[] {
  const listeners: ProcessListener[] = [];
  let pid: number | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) ? value : undefined;
    } else if (line.startsWith('n') && pid !== undefined) {
      const port = toPort(/:(\d+)$/.exec(line)?.[1]);
      if (port !== undefined) listeners.push({ pid, port });
    }
  }
  return listeners;
}

/** Parses `lsof -d cwd -F n` output: the `n<path>` line is the working directory. */
export function parseLsofCwd(output: string): string | undefined {
  const line = output.split('\n').find((entry) => entry.startsWith('n'));
  return line === undefined ? undefined : line.slice(1);
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      // `lsof` exits 1 when one of several processes could not be read, and still prints the rest.
      if (null !== error && 0 === stdout.length) reject(new Error(error.message));
      else resolve(stdout);
    });
  });
}

/**
 * The listener probe for this platform, or undefined where there is none.
 *
 * Linux and macOS list listeners with `lsof`. Linux reads a working directory from `/proc`, macOS
 * asks `lsof` again. Windows has no equivalent that names a working directory, so the source is off.
 */
export function systemListenerProbe(
  platform: NodeJS.Platform = process.platform,
): ListenerProbe | undefined {
  if (platform !== PLATFORM_LINUX && platform !== PLATFORM_DARWIN) return undefined;
  return {
    listeners: async () => parseLsofListeners(await run(LSOF, LSOF_LISTENERS_ARGS)),
    cwdOf: async (pid) => {
      if (platform === PLATFORM_LINUX) return readlink(PROC_CWD(pid)).catch(() => undefined);
      return parseLsofCwd(await run(LSOF, ['-p', String(pid), ...LSOF_CWD_ARGS]));
    },
  };
}
