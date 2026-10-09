/**
 * The real world, bound to the injected shape `runSetupPhases` expects.
 *
 * Everything here is a thin binding to something that already exists — `openInBrowser`,
 * `fetchStatus`, the driver table — with one exception: the dev server. Nothing else in the package
 * owns a spawned process, and owning one properly is most of this file.
 *
 * The promise this makes about that process: setup leaves it running on success, because an
 * instrumented app the user can watch IS the deliverable, and stops it on every other ending. A
 * server nobody started, holding a port nobody can account for, surviving the terminal that spawned
 * it, is the failure this file exists to avoid — measured, an interrupted run used to leave one
 * listening indefinitely.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlive } from '@/command/daemon/daemon.js';
import { DEV_SERVER_LOG_CAP_BYTES, ROTATED_SUFFIX } from './bringup/dev-server-log-cap.js';
import {
  devServerLogName,
  recordHandOver,
  sweepDeadDevServers,
} from './bringup/dev-server-files.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { reticleStateHome } from '@/command/daemon/daemon.js';
import {
  descendants,
  parseLsofPorts,
  parseNetstatListeners,
  parseWmicProcesses,
  type ProcessPair,
} from './terminal/listeners.js';
import type { CandidateSession } from './session-pick.js';
import type { PageProbe } from './probe/page-probe.js';
import { isAddressMiss, loopbackProbeUrls } from './probe/loopback-probe-urls.js';

const WINDOWS = 'win32' === process.platform;
/** Astro otherwise daemonizes automatically when it detects an agent terminal. */
const ASTRO_DEV_BACKGROUND_ENV = 'ASTRO_DEV_BACKGROUND';
/** A page fetch that is slow is a page fetch that failed, for our purposes. */
const PROBE_TIMEOUT_MS = 5_000;

/** The supervisor that owns the server's output and keeps its log bounded. */
const LOG_CAP_SCRIPT = fileURLToPath(new URL('./bringup/dev-server-log-cap.js', import.meta.url));

/** The dev server this process started, and the only one it will ever stop. */
export class OwnedDevServer {
  private child: ChildProcess | undefined;
  private log: string | undefined;
  private cwd: string | undefined;
  private startedAt = Date.now();
  private handedOver = false;

  constructor(private readonly logDir: string = reticleStateHome()) {}

  /**
   * Start it with its output going to a bounded log, through a supervisor that outlives `init`.
   *
   * Not a pipe into THIS process. A pipe's read end belonged to `init`; once it exited nobody held
   * it, and the server's next write (a compile error, an HMR line, SvelteKit's first warning) was an
   * EPIPE that killed it: "it connected, then the app went away". And not a bare file either, which
   * has no ceiling: an upstream echo loop grew one to 2.9 GB in five minutes. The supervisor reads
   * the server's pipes for as long as they are open and rotates the file past a cap — see
   * dev-server-log-cap.ts. It is the process group leader, so `pid()` and `stop()` cover both.
   */
  start(command: string, cwd: string, env: Readonly<Record<string, string>>): void {
    mkdirSync(this.logDir, { recursive: true });
    // Logs of servers that are gone, from every project, so the state home stops growing a file
    // per app ever started. This one's are replaced below anyway.
    sweepDeadDevServers(this.logDir, { alive: isAlive, now: Date.now(), keep: cwd });
    const log = join(this.logDir, devServerLogName(cwd));
    // Unlinked rather than truncated: a previous server for this project may still hold the old
    // file open, and truncating under it would interleave its lines into this run's output.
    rmSync(log, { force: true });
    rmSync(`${log}${ROTATED_SUFFIX}`, { force: true });
    this.child = spawn(
      process.execPath,
      [LOG_CAP_SCRIPT, log, String(DEV_SERVER_LOG_CAP_BYTES), command],
      {
        cwd,
        // Its own process group, so stopping it stops what it started rather than only the wrapper.
        // Detached on Windows too: there libuv puts every non-detached child in a job object that
        // kills it when this process exits. The supervisor died with `init`, the server it fed lost
        // its pipe reader, and its next log line was an EPIPE: every Windows install cell whose
        // server logs per request (Next, Astro) or on an edit (CRA, Angular) failed that way.
        detached: true,
        // Detached on Windows means no console; this keeps one from opening as a visible window.
        windowsHide: true,
        // Nothing of ours: the supervisor holds the server's pipes, and init holds none of its.
        stdio: 'ignore',
        // Reticle already provides the detached supervisor. Astro's agent auto-backgrounding
        // would escape its process group and leave the recorded handover PID pointing at a dead
        // launcher, so re-init and cleanup could no longer find or stop the actual server.
        env: { ...process.env, ...env, [ASTRO_DEV_BACKGROUND_ENV]: '1' },
      },
    );
    this.log = log;
    this.cwd = cwd;
    this.startedAt = Date.now();
  }

  /** Where the server's output goes, for the line that hands it over. */
  logPath(): string | undefined {
    return this.log;
  }

  /** The process group leader, for a caller that has to clean up what it handed over. */
  pid(): number | undefined {
    return this.child?.pid;
  }

  output(): string {
    if (undefined === this.log) return '';
    try {
      return readFileSync(this.log, 'utf8');
    } catch {
      return '';
    }
  }

  exited(): boolean {
    return undefined !== this.child && null !== this.child.exitCode;
  }

  /** Since the log last grew, which is since the server last printed anything. */
  quietForMs(): number {
    let lastOutputAt = this.startedAt;
    try {
      if (undefined !== this.log) lastOutputAt = Math.max(lastOutputAt, statSync(this.log).mtimeMs);
    } catch {
      /* not written yet */
    }
    // Filesystem timestamps can include a fractional millisecond beyond Date.now()'s integer.
    return Math.max(0, Date.now() - lastOutputAt);
  }

  /** Ports anything in this server's process tree is listening on. */
  listeningPorts(): number[] {
    const pid = this.child?.pid;
    if (undefined === pid) return [];
    if (WINDOWS) {
      const tree = new Set(descendants(windowsProcessPairs(), pid));
      return [
        ...new Set(
          parseNetstatListeners(run('netstat', ['-ano']))
            .filter((r) => tree.has(r.pid))
            .map((r) => r.port),
        ),
      ];
    }
    const pids = run('sh', ['-c', `ps -o pid= -g ${pid} 2>/dev/null | tr -d ' '`])
      .split('\n')
      .filter(Boolean);
    if (0 === pids.length) return [];
    return parseLsofPorts(
      run('sh', [
        '-c',
        `lsof -a -p ${pids.join(',')} -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR>1{print $9}'`,
      ]),
    );
  }

  /**
   * Leave the server running and stop holding it. After this, `stop()` does nothing.
   *
   * Only `unref` is needed: the output is the supervisor's, so no pipe of ours holds the event loop
   * (`init` once printed "setup complete" and hung on one). `url` is recorded beside the log, so the
   * next `init` attaches to this server rather than starting a second one beside it.
   */
  handOver(url?: string): void {
    this.handedOver = true;
    this.child?.unref();
    const pid = this.child?.pid;
    if (undefined !== url && undefined !== pid && undefined !== this.cwd) {
      recordHandOver(this.logDir, { pid, url, appDir: this.cwd });
    }
  }

  stop(): void {
    const child = this.child;
    if (this.handedOver || undefined === child?.pid) return;
    if (WINDOWS) run('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    }
    this.child = undefined;
  }
}

function run(file: string, args: string[]): string {
  const r = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return r.stdout ?? '';
}

/**
 * Every (pid, ppid) pair on a Windows machine — from `wmic` if it is there, PowerShell if not.
 *
 * `wmic` was the only source, and Microsoft has been removing it: deprecated since 21H1 and absent
 * from current Windows images. When it is missing `run` returns '' — the honest answer for a tool
 * that does not exist, and a catastrophic one here, because an empty process list means an empty
 * process TREE, which means no observed ports, which means the dev server's url is never found.
 * `init` then waits out the full quiet window and reports "the dev server stopped producing output
 * without ever serving a page" about a Vite server that was serving perfectly the whole time.
 *
 * The fallback prints the same two-integers-per-line shape, so `parseWmicProcesses` reads either
 * without knowing which produced it. Tried in this order because `wmic` is an order of magnitude
 * faster to start than PowerShell, and on a machine that still has it nothing needs to change.
 */
const POWERSHELL_PAIRS =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ParentProcessId) $($_.ProcessId)" }';

function windowsProcessPairs(): ProcessPair[] {
  const fromWmic = parseWmicProcesses(run('wmic', ['process', 'get', 'ParentProcessId,ProcessId']));
  if (0 < fromWmic.length) return fromWmic;
  return parseWmicProcesses(
    run('powershell', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PAIRS]),
  );
}

/**
 * Fetch the page and say what came back.
 *
 * A refused certificate is reported separately because the server ANSWERED: a self-signed dev cert
 * is an ordinary local setup, and calling it "nothing is listening" sends somebody to start a
 * server that is already running.
 *
 * On loopback, the announced host is tried first and the other loopback families follow when it
 * is REFUSED — so an IPv6-only Vite that printed `127.0.0.1` still counts as served (#884). Only
 * refused: a timeout means the right server is slow, and the caller polls again on the same host.
 * See `isAddressMiss` for the Next 16 first run that hopping on a timeout broke.
 */
export async function probePage(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<PageProbe> {
  const candidates = loopbackProbeUrls(url);
  let sawTlsRefused = false;
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.text();
      const sdkInPage = /@reticlehq|@reticle-connect|reticle-dev/.test(body);
      // Only stamp reachedUrl when we had to leave the announcement — callers that already have
      // the working URL should not rewrite it for a no-op.
      return candidate === url
        ? { served: true, sdkInPage }
        : { served: true, sdkInPage, reachedUrl: candidate };
    } catch (err) {
      const message = String(
        (err as { cause?: { message?: string }; message?: string })?.cause?.message ??
          (err as Error)?.message ??
          '',
      );
      if (/certificate|SELF_SIGNED|DEPTH_ZERO|ERR_TLS|unable to verify/i.test(message)) {
        sawTlsRefused = true;
      }
      if (!isAddressMiss(err)) break;
    }
  }
  return { served: false, sdkInPage: false, ...(sawTlsRefused ? { tlsRefused: true } : {}) };
}

/** Sessions the daemon is holding, in the shape the picker reads. */
export async function listSessions(port: number): Promise<CandidateSession[]> {
  try {
    const payload = await fetchStatus(port);
    const sessions = (payload as { sessions?: unknown }).sessions;
    return Array.isArray(sessions) ? (sessions as CandidateSession[]) : [];
  } catch {
    return [];
  }
}

/** Whether this project has a saved flow, wherever the project keeps one. */
export function flowsSaved(roots: readonly string[]): boolean {
  for (const root of roots) {
    try {
      if (0 < readdirSync(join(root, '.reticle', 'flows')).length) return true;
    } catch {
      /* no flows kept there */
    }
  }
  return false;
}

/** On PATH at all. The separate question of whether it RUNS is asked by chooseDriver. */
export function binaryExists(bin: string): boolean {
  return 0 === spawnSync(WINDOWS ? 'where' : 'which', [bin], { stdio: 'ignore' }).status;
}

/** Whether a directory looks like a project setup has already wired. */
export function alreadyWired(dir: string): boolean {
  return existsSync(join(dir, '.reticle.json'));
}
