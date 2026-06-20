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
