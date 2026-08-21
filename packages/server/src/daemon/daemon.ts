import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  openSync,
  closeSync,
  readdirSync,
  statSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { daemonRegistryFileName, ReticleEnv, type DaemonRegistryEntry } from '@reticlehq/core';
import { log } from '../log.js';
import { uncleanPredecessor } from './unclean-predecessor.js';

/** Env override for the whole state directory — see ReticleEnv.STATE_DIR. */
export const STATE_DIR_ENV = ReticleEnv.STATE_DIR;

/**
 * Where the daemon keeps pidfiles, the discovery registry and its logs.
 *
 * `~/.reticle` unless overridden. The override exists because a read-only $HOME is not hypothetical
 * — a sandboxed agent or a locked-down Windows profile cannot write there, and until now that meant
 * the daemon could not start at all. Read per call rather than captured at import, so a test (and a
 * wrapper that sets it late) sees the current value.
 */
export function reticleStateHome(): string {
  const override = process.env[STATE_DIR_ENV];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.reticle');
}

function pidPath(port: number, home: string = reticleStateHome()): string {
  return join(home, `daemon-${port}.pid`);
}

function registryPath(port: number): string {
  return join(reticleStateHome(), daemonRegistryFileName(port));
}

export function logPath(port: number): string {
  return join(reticleStateHome(), `daemon-${port}.log`);
}

/**
 * How large a daemon log may get before it is rolled over to `<name>.1`.
 *
 * It was unbounded. A real dev machine reached **24MB** on one port, which is not merely untidy: it
 * is the difference between a log somebody opens and a log somebody gives up on, and it is disk that
 * nothing ever reclaims. One previous generation is kept, because the question people bring to this
 * file ("what happened just now?") is answered by the current one and the question they bring next
 * ("and just before that?") is answered by the other.
 */
export const MAX_DAEMON_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Roll the log over if it has grown past the cap. Best-effort: a daemon must still start when the
 * log cannot be rotated, because failing to launch over housekeeping is strictly worse than a large
 * file.
 */
export function rotateDaemonLog(
  path: string,
  deps: { fileSize(p: string): number; renameFile(from: string, to: string): void },
  max: number = MAX_DAEMON_LOG_BYTES,
): boolean {
  try {
    if (max >= deps.fileSize(path)) return false;
    deps.renameFile(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

export function readPid(port: number, home: string = reticleStateHome()): number | null {
  const path = pidPath(port, home);
  if (!existsSync(path)) return null;
  const n = parseInt(readFileSync(path, 'utf8').trim(), 10);
  return isNaN(n) ? null : n;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writePid(port: number): void {
  mkdirSync(reticleStateHome(), { recursive: true });
  writeFileSync(pidPath(port), String(process.pid), 'utf8');
}

/**
 * Pure decision: may `expectedPid` remove a pidfile owned by `owner` (alive = is that owner running)?
 * Yes when we own it, it's empty, or its daemon is dead — never when a LIVE sibling owns it. This is
 * the orphan-race guard: a losing childB (EADDRINUSE) must not delete the winning childA's live pidfile.
 */
export function shouldRemovePid(
  owner: number | null,
  expectedPid: number,
  alive: boolean,
): boolean {
  return null === owner || owner === expectedPid || !alive;
}

export function removePid(port: number, expectedPid = process.pid): void {
  const path = pidPath(port);
  if (existsSync(path)) {
    const owner = readPid(port);
    if (shouldRemovePid(owner, expectedPid, owner !== null && isAlive(owner))) unlinkSync(path);
  }
  // The discovery registry entry shares this daemon's lifetime — clean both so a dead daemon never
  // lingers in discovery. Keyed by port, so this is safe from the parent (stop) or the child (shutdown).
  removeDaemonRegistry(port);
}

/**
 * Publish this daemon to the discovery registry so a build-time plugin can find it by projectId. Called
 * from the daemon CHILD on ready (only it knows its cwd/projectId). Best-effort: a write failure must
 * never fail daemon startup — discovery just falls back to the default port.
 */
export function writeDaemonRegistry(
  port: number,
  meta: { pid: number; cwd: string; projectId?: string; startedAt: number },
): void {
  const entry: DaemonRegistryEntry = {
    port,
    pid: meta.pid,
    cwd: meta.cwd,
    startedAt: meta.startedAt,
    ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
  };
  try {
    mkdirSync(reticleStateHome(), { recursive: true });
    writeFileSync(registryPath(port), JSON.stringify(entry), 'utf8');
  } catch {
    // discovery is a convenience — never block startup on it
  }
}

function removeDaemonRegistry(port: number): void {
  const path = registryPath(port);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // racing another cleaner — already gone
  }
}

export function isRunning(port: number): boolean {
  const pid = readPid(port);
  return pid !== null && isAlive(pid);
}

/**
 * Find the port of a live reticle daemon by scanning ~/.reticle/daemon-<port>.pid files — so `reticle open`
 * can "find the port" itself instead of making the user reconcile it. Returns the first live one
 * (lowest port, deterministic), or null when none is running.
 */
export function discoverDaemonPort(): number | null {
  reclaimStaleDaemons(); // sweep crashed daemons' stale pidfiles before scanning for live ones
  let found: number | null = null;
  try {
    for (const file of readdirSync(reticleStateHome())) {
      const m = /^daemon-(\d+)\.pid$/.exec(file);
      if (null === m) continue;
      const port = Number(m[1]);
      if (isRunning(port) && (null === found || port < found)) found = port;
    }
  } catch {
    // no ~/.reticle yet → nothing running
  }
  return found;
}

/**
 * Sweep ~/.reticle for daemon-<port>.pid files whose process is no longer alive and delete them, so a
 * crashed daemon never leaves a stale pidfile that confuses discovery or makes a port look "taken".
 * Returns the ports reclaimed. `home` and `pidAlive` are injectable for testing (default to the real
 * ~/.reticle and the process.kill(pid,0) liveness probe).
 */
export function reclaimStaleDaemons(
  home: string = reticleStateHome(),
  pidAlive: (pid: number) => boolean = isAlive,
): number[] {
  const reclaimed: number[] = [];
  let files: string[];
  try {
    files = readdirSync(home);
  } catch {
    return reclaimed; // no ~/.reticle yet → nothing to reclaim
  }
  for (const file of files) {
    const match = /^daemon-(\d+)\.pid$/.exec(file);
    if (null === match) continue;
    const path = join(home, file);
    let pid: number | null = null;
    try {
      pid = parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (isNaN(pid)) pid = null;
    } catch {
      pid = null; // unreadable pidfile counts as stale
    }
    if (null === pid || !pidAlive(pid)) {
      try {
        unlinkSync(path);
        removeDaemonRegistry(Number(match[1])); // drop the sidecar discovery entry too
        reclaimed.push(Number(match[1]));
      } catch {
        // racing another reclaimer — fine, it's already gone
      }
    }
  }
  return reclaimed;
}

/**
 * Find all live Reticle daemons OTHER than `ownPort` by scanning the pid file registry.
 *
 * Injectable `home` and `pidAlive` follow `reclaimStaleDaemons`'s pattern for testability.
 */
export function discoverSiblingDaemons(
  ownPort: number,
  home: string = reticleStateHome(),
  pidAlive: (pid: number) => boolean = isAlive,
): readonly number[] {
  const siblings: number[] = [];
  let files: string[];
  try {
    files = readdirSync(home);
  } catch {
    return siblings;
  }
  for (const file of files) {
    const m = /^daemon-(\d+)\.pid$/.exec(file);
    if (null === m) continue;
    const port = Number(m[1]);
    if (port === ownPort) continue;
    let pid: number | null = null;
    try {
      pid = parseInt(readFileSync(join(home, file), 'utf8').trim(), 10);
      if (isNaN(pid)) pid = null;
    } catch {
      pid = null;
    }
    if (null !== pid && pidAlive(pid)) siblings.push(port);
  }
  return siblings;
}

/** The minimal shape of a spawned child that spawnDaemon uses. */
export interface SpawnedChild {
  readonly pid?: number | undefined;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  unref(): void;
}

/** Injectable deps for spawnDaemon — the testability seam. Defaults to the real implementations. */
export interface SpawnDaemonDeps {
  readonly home: string;
  openFile(path: string, flags: string): number;
  closeFile(fd: number): void;
  /** Size in bytes, or 0 when the file does not exist yet. */
  fileSize(path: string): number;
  renameFile(from: string, to: string): void;
  spawnChild(
    command: string,
    args: readonly string[],
    options: { detached: boolean; stdio: readonly ('ignore' | number)[] },
  ): SpawnedChild;
  pidAlive(pid: number): boolean;
}

function defaultSpawnDaemonDeps(): SpawnDaemonDeps {
  return {
    home: reticleStateHome(),
    openFile: openSync,
    closeFile: closeSync,
    fileSize: (path) => (existsSync(path) ? statSync(path).size : 0),
    renameFile: renameSync,
    spawnChild: (command, args, options) =>
      spawn(command, [...args], { detached: options.detached, stdio: [...options.stdio] }),
    pidAlive: isAlive,
  };
}

/**
 * Spawn the reticle daemon as a detached background process, redirecting output to the log file.
 * Writes the PID file from the parent before returning so callers can call isRunning
 * immediately without a race window.
 *
 * `deps` is injectable for testing (default: real fs/spawn against ~/.reticle). The same seam
 * pattern as reclaimStaleDaemons(home, pidAlive).
 */
export function spawnDaemon(
  nodeExec: string,
  scriptPath: string,
  args: string[],
  port: number,
  deps: SpawnDaemonDeps = defaultSpawnDaemonDeps(),
): boolean {
  try {
    mkdirSync(deps.home, { recursive: true });
  } catch (err) {
    // The log-file open below has always been guarded; this was not, so the ONE failure a sandboxed
    // agent actually hits — a read-only $HOME — escaped as a raw EACCES naming nothing. Refuse
    // loudly, and name the way out.
    log('reticle_daemon_state_unwritable', {
      home: deps.home,
      error: err instanceof Error ? err.message : String(err),
      fix: `Reticle could not create its state directory. Set ${STATE_DIR_ENV} to a writable path and retry.`,
    });
    return false;
  }
  const pidFilePath = join(deps.home, `daemon-${port}.pid`);
  const logFilePath = join(deps.home, `daemon-${port}.log`);
  // O_EXCL spawn-lock: only the FIRST racer to create the pidfile spawns. A concurrent second gets
  // EEXIST — if a LIVE daemon owns the port it skips (no duplicate detached daemon, no clobbered pid);
  // a stale pidfile from a crashed daemon is reclaimed. Returns false when it did not spawn.
  /** Set when this start reclaimed a pidfile whose owner is gone — see unclean-predecessor.ts. */
  let orphanPid: number | null = null;
  let lockFd: number;
  try {
    lockFd = deps.openFile(pidFilePath, 'wx');
  } catch {
    const existing = readPid(port, deps.home);
    if (existing !== null && deps.pidAlive(existing)) return false;
    // This branch IS the crash detection — its own comment has always said so ("a stale pidfile from
    // a crashed daemon is reclaimed"), it just never said it out loud. Captured before the unlink,
    // because after it there is no trace left that the previous daemon died at all.
    orphanPid = uncleanPredecessor(existing, false, process.pid);
    try {
      unlinkSync(pidFilePath);
      lockFd = deps.openFile(pidFilePath, 'wx');
    } catch {
      return false; // lost a concurrent reclaim race
    }
  }
  // Roll the log BEFORE opening the append handle, or the daemon writes into the renamed file
  // through an fd that no longer matches any name anyone can find.
  rotateDaemonLog(logFilePath, deps);
  let logFd: number;
  try {
    logFd = deps.openFile(logFilePath, 'a');
  } catch {
    // Log path unwritable (permissions, disk full). Clean up the lock so we don't leave a ghost.
    deps.closeFile(lockFd);
    try {
      unlinkSync(pidFilePath);
    } catch {
      // racing another reclaimer — fine
    }
    return false;
  }
  // Into the daemon log itself, not the parent's stdout: `doctor` points the reader at this file, and
  // a death recorded anywhere else is a death they will not find. Written through the fd the child is
  // about to inherit, so it lands immediately before that child's first line — exactly where a reader
  // comparing two `mcp_daemon_started` entries is already looking.
  if (null !== orphanPid) {
    try {
      writeSync(
        logFd,
        `${JSON.stringify({
          // Same convention as log(): the clock is read at the I/O boundary, not injected.
          t: new Date().toISOString(),
          event: 'reticle_daemon_previous_died_unclean',
          port,
          pid: orphanPid,
        })}\n`,
      );
    } catch {
      // A log we cannot write is not a reason to refuse to start the daemon.
    }
  }
  let child: SpawnedChild;
  try {
    child = deps.spawnChild(nodeExec, [scriptPath, ...args], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } catch {
    // spawn can throw synchronously on some platforms (e.g. ENOMEM, invalid args).
    deps.closeFile(logFd);
    deps.closeFile(lockFd);
    try {
      unlinkSync(pidFilePath);
    } catch {
      // racing another reclaimer — fine
    }
    return false;
  }
  // The parent's copy of logFd is no longer needed — spawn duplicated it into the child.
  deps.closeFile(logFd);
  // Suppress the async ENOENT/EACCES that fires when the executable is missing or unexecutable.
  // The failure is already detected synchronously via `child.pid === undefined`; without this
  // handler the error propagates as an uncaught exception and crashes the parent process.
  child.on('error', () => undefined);
  if (child.pid === undefined) {
    // Spawn failed silently (resource exhaustion, invalid executable on some platforms). The pidfile
    // is empty — clean it up so discovery doesn't see a ghost, and report failure honestly.
    deps.closeFile(lockFd);
    try {
      unlinkSync(pidFilePath);
    } catch {
      // racing another reclaimer — fine
    }
    return false;
  }
  writeFileSync(lockFd, String(child.pid), 'utf8');
  deps.closeFile(lockFd);
  child.unref();
  return true;
}
