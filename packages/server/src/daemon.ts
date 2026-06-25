import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  openSync,
  readdirSync,
} from 'node:fs';
import { spawn } from 'node:child_process';

const IRIS_HOME = join(homedir(), '.iris');

export function pidPath(port: number): string {
  return join(IRIS_HOME, `daemon-${port}.pid`);
}

export function logPath(port: number): string {
  return join(IRIS_HOME, `daemon-${port}.log`);
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
  mkdirSync(IRIS_HOME, { recursive: true });
  writeFileSync(pidPath(port), String(process.pid), 'utf8');
}

export function removePid(port: number): void {
  const path = pidPath(port);
  if (existsSync(path)) unlinkSync(path);
}

export function isRunning(port: number): boolean {
  const pid = readPid(port);
  return pid !== null && isAlive(pid);
}

/**
 * Find the port of a live iris daemon by scanning ~/.iris/daemon-<port>.pid files — so `iris open`
 * can "find the port" itself instead of making the user reconcile it. Returns the first live one
 * (lowest port, deterministic), or null when none is running.
 */
export function discoverDaemonPort(): number | null {
  reclaimStaleDaemons(); // sweep crashed daemons' stale pidfiles before scanning for live ones
  let found: number | null = null;
  try {
    for (const file of readdirSync(IRIS_HOME)) {
      const m = /^daemon-(\d+)\.pid$/.exec(file);
      if (m === null) continue;
      const port = Number(m[1]);
      if (isRunning(port) && (found === null || port < found)) found = port;
    }
  } catch {
    // no ~/.iris yet → nothing running
  }
  return found;
}

/**
 * Sweep ~/.iris for daemon-<port>.pid files whose process is no longer alive and delete them, so a
 * crashed daemon never leaves a stale pidfile that confuses discovery or makes a port look "taken".
 * Returns the ports reclaimed. `home` and `pidAlive` are injectable for testing (default to the real
 * ~/.iris and the process.kill(pid,0) liveness probe).
 */
export function reclaimStaleDaemons(
  home: string = IRIS_HOME,
  pidAlive: (pid: number) => boolean = isAlive,
): number[] {
  const reclaimed: number[] = [];
  let files: string[];
  try {
    files = readdirSync(home);
  } catch {
    return reclaimed; // no ~/.iris yet → nothing to reclaim
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
        reclaimed.push(Number(match[1]));
      } catch {
        // racing another reclaimer — fine, it's already gone
      }
    }
  }
  return reclaimed;
}

/**
 * Spawn the iris daemon as a detached background process, redirecting output to the log file.
 * Writes the PID file from the parent before returning so callers can call isRunning()
 * immediately without a race window.
 */
export function spawnDaemon(
  nodeExec: string,
  scriptPath: string,
  args: string[],
  port: number,
): void {
  mkdirSync(IRIS_HOME, { recursive: true });
  const fd = openSync(logPath(port), 'a');
  const child = spawn(nodeExec, [scriptPath, ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  if (child.pid !== undefined) {
    writeFileSync(pidPath(port), String(child.pid), 'utf8');
  }
  child.unref();
}
