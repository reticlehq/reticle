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
} from 'node:fs';
import { spawn } from 'node:child_process';
import {
  daemonRegistryFileName,
  daemonRegistryPort,
  DaemonRegistryEntrySchema,
  pickDaemonPort,
  type DaemonRegistryEntry,
} from '@reticlehq/core';

const RETICLE_HOME = join(homedir(), '.reticle');

function pidPath(port: number): string {
  return join(RETICLE_HOME, `daemon-${port}.pid`);
}

function registryPath(port: number): string {
  return join(RETICLE_HOME, daemonRegistryFileName(port));
}

export function logPath(port: number): string {
  return join(RETICLE_HOME, `daemon-${port}.log`);
}

export function readPid(port: number): number | null {
  const path = pidPath(port);
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
  mkdirSync(RETICLE_HOME, { recursive: true });
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
  return owner === null || owner === expectedPid || !alive;
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
    mkdirSync(RETICLE_HOME, { recursive: true });
    writeFileSync(registryPath(port), JSON.stringify(entry), 'utf8');
  } catch {
    // discovery is a convenience — never block startup on it
  }
}

export function removeDaemonRegistry(port: number): void {
  const path = registryPath(port);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // racing another cleaner — already gone
  }
}

/**
 * Discover the port of a live daemon serving `projectId` by reading the registry entries in ~/.reticle.
 * Returns null when none matches (caller falls back to the default port — never guesses a mismatched
 * daemon). Stale entries (crashed daemons) are ignored via the pid liveness probe.
 */
export function discoverDaemonPortForProject(projectId: string | undefined): number | null {
  const entries: DaemonRegistryEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(RETICLE_HOME);
  } catch {
    return null; // no ~/.reticle yet
  }
  for (const file of files) {
    if (daemonRegistryPort(file) === null) continue;
    try {
      const parsed = DaemonRegistryEntrySchema.safeParse(
        JSON.parse(readFileSync(join(RETICLE_HOME, file), 'utf8')),
      );
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // unreadable/corrupt entry — skip it
    }
  }
  return pickDaemonPort(entries, projectId, isAlive);
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
    for (const file of readdirSync(RETICLE_HOME)) {
      const m = /^daemon-(\d+)\.pid$/.exec(file);
      if (m === null) continue;
      const port = Number(m[1]);
      if (isRunning(port) && (found === null || port < found)) found = port;
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
  home: string = RETICLE_HOME,
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
    if (match === null) continue;
    const path = join(home, file);
    let pid: number | null = null;
    try {
      pid = parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (isNaN(pid)) pid = null;
    } catch {
      pid = null; // unreadable pidfile counts as stale
    }
    if (pid === null || !pidAlive(pid)) {
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
 * Spawn the reticle daemon as a detached background process, redirecting output to the log file.
 * Writes the PID file from the parent before returning so callers can call isRunning()
 * immediately without a race window.
 */
export function spawnDaemon(
  nodeExec: string,
  scriptPath: string,
  args: string[],
  port: number,
): boolean {
  mkdirSync(RETICLE_HOME, { recursive: true });
  const path = pidPath(port);
  // O_EXCL spawn-lock: only the FIRST racer to create the pidfile spawns. A concurrent second gets
  // EEXIST — if a LIVE daemon owns the port it skips (no duplicate detached daemon, no clobbered pid);
  // a stale pidfile from a crashed daemon is reclaimed. Returns false when it did not spawn.
  let lockFd: number;
  try {
    lockFd = openSync(path, 'wx');
  } catch {
    const existing = readPid(port);
    if (existing !== null && isAlive(existing)) return false;
    try {
      unlinkSync(path);
      lockFd = openSync(path, 'wx');
    } catch {
      return false; // lost a concurrent reclaim race
    }
  }
  const logFd = openSync(logPath(port), 'a');
  const child = spawn(nodeExec, [scriptPath, ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  if (child.pid !== undefined) {
    writeFileSync(lockFd, String(child.pid), 'utf8');
  }
  closeSync(lockFd);
  child.unref();
  return true;
}
