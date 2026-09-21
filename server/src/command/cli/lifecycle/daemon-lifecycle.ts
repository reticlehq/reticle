/**
 * Starting, stopping and restarting the daemon — the three commands that decide whether a `reticle`
 * process exists, and the waiting each of them has to do to answer honestly.
 *
 * Lifted out of `cli.ts` for the reason `cli-launch.ts` was before it: that file sat at exactly the
 * thousand-line cap, so the next line added to it — to any command, related or not — failed the
 * build. This is the largest group in it that is one idea rather than several.
 *
 * The idea is: a lifecycle command must report what is actually the case, and the only way to know
 * that is to wait and look. `serve` waits for the daemon to ANSWER before claiming it started,
 * because the child binds asynchronously and a parent that reports the spawn reports a guess.
 * `stop` waits for the process to be gone and escalates when it is not, because a daemon that
 * ignores SIGTERM is the one situation `stop` exists for. `restart` reports its two halves
 * separately, because "killed nothing" and "killed it but could not start a new one" leave the user
 * in different places and one exit code cannot say which.
 */

import { log } from '@/log.js';
import { RETICLE_VERIFY_DEFAULT_PORT } from '@/index.js';
import { verifyEndpointMismatch } from '@/status-payload.js';
import { probeDaemon } from '@/surface/mcp/mcp-proxy.js';
import { stateDirProblem } from '@/command/daemon/state-dir.js';
import {
  readPid,
  isAlive,
  removePid,
  spawnDaemon,
  logPath,
  reticleStateHome,
} from '@/command/daemon/daemon.js';
import { readDaemonStartupCause } from '@/command/daemon/lifetime/startup-failure.js';
import {
  PortPresence,
  probePresence,
  describePresence,
} from '@/command/daemon/binding/port-presence.js';
import { daemonSpawnArgs } from '@/command/cli/daemon-start-options.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { runKill } from '@/command/cli/cli-kill.js';

export function handleServe(parsed: {
  port: number;
  driveUrl?: string;
  headless: boolean;
  http: boolean;
  httpPort?: number;
  httpToken?: string;
}): void {
  void serveWithHonestExit(parsed);
}

/**
 * Report the BIND, not the spawn.
 *
 * `serve` used to log `reticle_daemon_spawned` and exit 0 unconditionally, while the child died at
 * `reticle_daemon_start_failed` with an EADDRINUSE nothing joined back to the parent. Three surfaces
 * then disagreed about what was true and none of them named the port.
 *
 * Two changes, both about saying what is actually the case: refuse up front when the port is held by
 * something that is not a Reticle daemon (a spawn there cannot succeed), and after spawning, wait
 * for the daemon to actually answer before claiming it started.
 */
async function serveWithHonestExit(parsed: {
  port: number;
  driveUrl?: string;
  headless: boolean;
  http: boolean;
  httpPort?: number;
  httpToken?: string;
}): Promise<void> {
  const presence = await probePresence(parsed.port, {
    tcpOpen: probeDaemon,
    status: fetchStatus,
  });
  if (presence === PortPresence.DAEMON) {
    // A daemon that is already up was started with ITS flags, not these — `serve` only attaches.
    // Exiting 0 here regardless is how `--http-port` came to be accepted and ignored (#687): the
    // running daemon kept serving whatever it was started with, and the flag vanished without a
    // word. Ask the daemon which verify port it actually serves and refuse when it is not the one
    // requested — a flag that cannot be honoured must say so, not report success.
    if (parsed.http) {
      const mismatch = verifyEndpointMismatch(
        await fetchStatus(parsed.port),
        parsed.httpPort ?? RETICLE_VERIFY_DEFAULT_PORT,
      );
      if (mismatch !== undefined) {
        log('reticle_daemon_start_refused', { port: parsed.port, reason: mismatch });
        process.stderr.write(`${mismatch}\n`);
        process.exit(1);
        return;
      }
    }
    log('reticle_daemon_already_running', { port: parsed.port });
    return;
  }
  if (presence === PortPresence.FOREIGN) {
    log('reticle_daemon_start_refused', {
      port: parsed.port,
      presence,
      reason: describePresence(presence, parsed.port),
    });
    process.stderr.write(`${describePresence(presence, parsed.port)}\n`);
    process.exit(1);
    return;
  }
  const scriptPath = process.argv[1];
  if (scriptPath === undefined) {
    log('reticle_serve_no_script', {});
    process.exit(1);
    return;
  }
  const daemonArgs = daemonSpawnArgs(parsed);
  const startupStartedAt = Date.now();
  spawnDaemon(process.execPath, scriptPath, daemonArgs, parsed.port);
  // The child binds asynchronously and, when it cannot, exits 1 long after this process would have
  // reported success. Wait for it to ANSWER — `/status` responding is the only evidence a daemon
  // exists that does not come from the pid file the child may never have earned.
  const bound = await waitForPresence(parsed.port, PortPresence.DAEMON, SERVE_BIND_TIMEOUT_MS);
  if (!bound) {
    const settled = await probePresence(parsed.port, { tcpOpen: probeDaemon, status: fetchStatus });
    const startupCause = readDaemonStartupCause(logPath(parsed.port), startupStartedAt);
    log('reticle_daemon_start_failed_parent', {
      port: parsed.port,
      presence: settled,
      reason: describePresence(settled, parsed.port),
      log: logPath(parsed.port),
      stateDir: stateDirProblem(reticleStateHome()) === undefined ? 'writable' : 'unwritable',
      ...(startupCause === undefined ? {} : { cause: startupCause }),
    });
    // Name the CAUSE when we can see it. An unwritable state directory is a first-run failure mode
    // (locked-down home, read-only container mount, managed profile) that produced only "nothing is
    // listening" — the symptom restated — and then pointed at a log INSIDE that directory, which
    // cannot exist. Reproduced with `chmod 555 ~/.reticle`.
    const dirProblem = stateDirProblem(reticleStateHome());
    process.stderr.write(
      dirProblem === undefined
        ? startupCause === undefined
          ? `the daemon did not come up on :${String(parsed.port)} — ${describePresence(settled, parsed.port)}\n` +
            `see ${logPath(parsed.port)}\n`
          : `the daemon did not come up on :${String(parsed.port)}.\n${startupCause}\n` +
            `see ${logPath(parsed.port)}\n`
        : `the daemon did not come up on :${String(parsed.port)}.\n${dirProblem}\n`,
    );
    process.exit(1);
    return;
  }
  log('reticle_daemon_spawned', { port: parsed.port, ...(parsed.http ? { http: true } : {}) });
}

/** How long `serve` waits for the child to bind. Generous: a cold daemon start is seconds. */
const SERVE_BIND_TIMEOUT_MS = 15_000;
const PRESENCE_POLL_MS = 150;

/** How long a daemon gets to shut down on its own before `stop` stops asking politely. */
const GRACEFUL_STOP_MS = 5000;
/** How long after SIGKILL before we accept the process is not ours to kill and say so. */
const FORCED_STOP_MS = 2000;

async function waitForPresence(
  port: number,
  want: PortPresence,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
    if (presence === want) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, PRESENCE_POLL_MS));
  }
}

export function handleStop(port: number, quiet: boolean): void {
  const pid = readPid(port);
  if (null === pid || !isAlive(pid)) {
    removePid(port);
    if (!quiet) log('reticle_daemon_not_running', { port });
    return;
  }
  process.kill(pid, 'SIGTERM');
  const started = Date.now();
  let escalated = false;
  const poll = setInterval(() => {
    if (!isAlive(pid)) {
      clearInterval(poll);
      removePid(port);
      if (!quiet) log('reticle_daemon_stopped', { port, pid, ...(escalated ? { escalated } : {}) });
      return;
    }
    const waited = Date.now() - started;
    // A daemon that ignores SIGTERM is WEDGED — which is the one situation `stop` exists for. Giving
    // up here left the port held, the pid file stale, and a human running `kill -9` by hand at the
    // first two minutes of setup. Escalate instead: graceful first, then unconditional.
    if (!escalated && waited > GRACEFUL_STOP_MS) {
      escalated = true;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone between the liveness check and here — the next tick reports it stopped.
      }
      return;
    }
    if (waited > GRACEFUL_STOP_MS + FORCED_STOP_MS) {
      clearInterval(poll);
      // Surviving SIGKILL means the pid is not ours to kill (permissions) or is an unkillable
      // zombie. Neither is retryable, and both need the pid named so a human can act on it.
      if (!quiet) log('reticle_daemon_stop_timeout', { port, pid, escalated });
      process.exit(1);
    }
  }, 100);
}

/**
 * `reticle restart` — free the port, then put a daemon back on it and prove it bound.
 *
 * The two halves are reported separately on purpose. A restart that killed the old daemon and then
 * could not start a new one leaves the user in a different place from one that could not kill
 * anything at all, and a single `ok: false` cannot tell them which happened.
 */
export async function handleRestart(port: number, force: boolean): Promise<void> {
  const freed = await runKill(port, force);
  if (!freed) {
    log('reticle_restart_aborted', {
      port,
      reason: 'the port was not freed, so nothing was started — the old holder is still there',
    });
    process.exit(1);
    return;
  }
  // Reuses `serve`'s path, which waits for the daemon to ANSWER before claiming it started and exits
  // non-zero when it does not. A restart that reports success for a daemon that never bound is the
  // same lie `serve` already stopped telling.
  await serveWithHonestExit({ port, headless: true, http: false });
}
