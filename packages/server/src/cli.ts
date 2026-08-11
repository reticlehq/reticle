#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  handleWatch,
  handleCapsules,
  handleGate,
  loadNamedFlows,
  resolveChangedFiles,
} from './cli/cli-flow-commands.js';
import { RETICLE_DEFAULT_PORT, ReticleDir, ReticleEnv } from '@reticlehq/core';
import { loadDotEnv } from './telemetry/dev-repo.js';
import { createNodeFileSystem } from './project/fs-port.js';
import { affectedSavedFlows } from './flows/flow-sources.js';

import { availableUpdate } from './update/update-nudge.js';
import { handleUpdate, handleRollback } from './cli/cli-update-commands.js';

import { start, startDaemon } from './index.js';
import { isCloudCommand, runCloudCommand } from './cli/cloud-cli.js';
import { SERVER_VERSION } from './version/server-version.js';
import { log } from './log.js';
import {
  readPid,
  isAlive,
  removePid,
  spawnDaemon,
  discoverDaemonPort,
  writeDaemonRegistry,
  logPath,
} from './daemon/daemon.js';
import {
  PortPresence,
  probePresence,
  presenceIsUsable,
  describePresence,
} from './daemon/port-presence.js';
import {
  waitForDaemon,
  startMcpProxy,
  probeDaemon,
  proxyLog,
  setProxyLogPort,
} from './mcp/mcp-proxy.js';
import {
  installDaemonResilience,
  installProxyResilience,
  recordExitReason,
  DaemonExitReason,
} from './daemon/daemon-resilience.js';
import { IdleShutdown, resolveIdleShutdownMs, resolveIdleCheckMs } from './daemon/idle-shutdown.js';
import { DaemonHeartbeat, resolveHeartbeatMs } from './daemon/heartbeat.js';
import { everServedToolCall } from './daemon/daemon-usefulness.js';
import {
  fetchStatus,
  summarizeStatus,
  warnOnDaemonSkew,
  decideOpen,
  openInBrowser,
} from './cli/cli-launch.js';
import { handleVerify } from './cli/cli-verify.js';
import { summarizeHunt, type HuntAnomaly, type HuntRun } from './hunt/hunt-report.js';
import { runInit } from './init/run.js';
import { handleDoctor } from './cli/cli-doctor.js';
import { buildNodeIo } from './init/node-io.js';
import { describeLicense } from './license/license.js';
import {
  isLikelyDevServerPort,
  devServerPortWarning,
  readProjectPort,
  readProjectId,
} from './cli/cli-port.js';
import type { StartOptions } from './index.js';

import {
  DAEMON_INNER_COMMAND,
  PORT_FLAG,
  DRIVE_FLAG,
  HEADED_FLAG,
  HTTP_FLAG,
  HTTP_PORT_FLAG,
  HTTP_TOKEN_FLAG,
  parseCliArgs,
  CLI_USAGE,
} from './cli/cli-parse.js';
import { handleFeedback, handleIdentify, handleTelemetry } from './telemetry/feedback-cli.js';
import { installDaemonTelemetry } from './telemetry/daemon-telemetry.js';
import { reportCliRun } from './telemetry/cli-telemetry.js';

// Re-exported so existing imports (and the CLI tests) keep resolving from './cli.js'.
export { parseCliArgs, CLI_USAGE };
export type { CliResult } from './cli/cli-parse.js';

function handleInit(parsed: {
  port: number | undefined;
  mcp: boolean;
  dryRun: boolean;
  install: boolean;
  app?: string | undefined;
}): void {
  const cwd = process.cwd();
  const result = runInit(
    {
      cwd,
      port: parsed.port,
      mcp: parsed.mcp,
      dryRun: parsed.dryRun,
      install: parsed.install,
      ...(parsed.app === undefined ? {} : { app: parsed.app }),
    },
    buildNodeIo(cwd),
  );
  if (!result.ok) process.exit(1);
}

function handleServe(parsed: {
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
  const daemonArgs = [DAEMON_INNER_COMMAND, PORT_FLAG, String(parsed.port)];
  if (parsed.driveUrl !== undefined) {
    daemonArgs.push(DRIVE_FLAG, parsed.driveUrl);
    if (!parsed.headless) daemonArgs.push(HEADED_FLAG);
  }
  if (parsed.http) {
    daemonArgs.push(HTTP_FLAG);
    if (parsed.httpPort !== undefined) daemonArgs.push(HTTP_PORT_FLAG, String(parsed.httpPort));
    if (parsed.httpToken !== undefined) daemonArgs.push(HTTP_TOKEN_FLAG, parsed.httpToken);
  }
  spawnDaemon(process.execPath, scriptPath, daemonArgs, parsed.port);
  // The child binds asynchronously and, when it cannot, exits 1 long after this process would have
  // reported success. Wait for it to ANSWER — `/status` responding is the only evidence a daemon
  // exists that does not come from the pid file the child may never have earned.
  const bound = await waitForPresence(parsed.port, PortPresence.DAEMON, SERVE_BIND_TIMEOUT_MS);
  if (!bound) {
    const settled = await probePresence(parsed.port, { tcpOpen: probeDaemon, status: fetchStatus });
    log('reticle_daemon_start_failed_parent', {
      port: parsed.port,
      presence: settled,
      reason: describePresence(settled, parsed.port),
      log: logPath(parsed.port),
    });
    process.stderr.write(
      `the daemon did not come up on :${String(parsed.port)} — ${describePresence(settled, parsed.port)}\n` +
        `see ${logPath(parsed.port)}\n`,
    );
    process.exit(1);
    return;
  }
  log('reticle_daemon_spawned', { port: parsed.port, ...(parsed.http ? { http: true } : {}) });
}

/** How long `serve` waits for the child to bind. Generous: a cold daemon start is seconds. */
const SERVE_BIND_TIMEOUT_MS = 15_000;
const PRESENCE_POLL_MS = 150;

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

function handleStop(port: number, quiet: boolean): void {
  const pid = readPid(port);
  if (null === pid || !isAlive(pid)) {
    removePid(port);
    if (!quiet) log('reticle_daemon_not_running', { port });
    return;
  }
  process.kill(pid, 'SIGTERM');
  const started = Date.now();
  const poll = setInterval(() => {
    if (!isAlive(pid)) {
      clearInterval(poll);
      removePid(port);
      if (!quiet) log('reticle_daemon_stopped', { port, pid });
      return;
    }
    if (Date.now() - started > 5000) {
      clearInterval(poll);
      if (!quiet) log('reticle_daemon_stop_timeout', { port, pid });
      process.exit(1);
    }
  }, 100);
}

function handleStatus(port: number): void {
  const pid = readPid(port);
  if (null === pid || !isAlive(pid)) {
    // `running: false` on its own has been reported about a port that was demonstrably occupied,
    // because the pid file is not the port. Ask the port before answering.
    void probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus }).then((presence) => {
      log('reticle_status', {
        port,
        running: presenceIsUsable(presence),
        presence,
        ...(presence === PortPresence.FOREIGN ? { reason: describePresence(presence, port) } : {}),
      });
    });
    return;
  }
  // The daemon is up — ask it for live sessions + health so status is at-a-glance, not just a pid.
  void fetchStatus(port).then((payload) => {
    // `status` is the second-most-run command and the one a HUMAN types. The update nudge otherwise
    // only rides a tool result, which the majority of daemons never produce — so the people most in
    // need of an upgrade were the ones with no path to hearing about it.
    const update = availableUpdate();
    const nudge = update === undefined ? {} : { updateAvailable: update };
    if (payload === undefined) {
      log('reticle_status', { port, running: true, pid, ...nudge });
      return;
    }
    log('reticle_status', { port, running: true, pid, ...summarizeStatus(payload), ...nudge });
  });
}

/** Print the running package version (resolved once in server-version.ts). */
function handleVersion(): void {
  log('reticle_version', { version: SERVER_VERSION });
}

/** `reticle license` — show enterprise activation resolved from the environment (offline; nothing leaves). */
function handleLicense(): void {
  log('reticle_license', { ...describeLicense(Date.now()) });
}

/**
 * `reticle affected <file...>` — print which saved flows must re-verify for the given changed files.
 * Environment-side (costs the agent nothing per turn); the foundation of watch/gate. Never throws:
 * a load error is logged, not fatal.
 */

async function handleAffected(files: string[], since: string | undefined): Promise<void> {
  try {
    const fs = createNodeFileSystem();
    const reticleRoot = join(process.cwd(), ReticleDir.ROOT);
    const changed = await resolveChangedFiles(files, since);
    const result = affectedSavedFlows(await loadNamedFlows(fs, reticleRoot), changed);
    log('reticle_affected', {
      changedFiles: changed,
      affected: result.affected,
      unknownProvenance: result.unknownProvenance,
    });
  } catch (error) {
    log('reticle_affected_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `reticle hunt <dir>` — aggregate crawl reports from many checkouts into one number.
 *
 * Detection already exists (`reticle_crawl`). This is the arithmetic that turns a pile of runs into
 * the claim worth making: over N already-merged, already-green changes, how many carried a candidate
 * false green? No control arm is needed, because those changes SHIPPED — the counterfactual is
 * already established, which is what makes this the cheapest credible evidence available.
 *
 * Each file in <dir> is one crawl result. Producing them is a shell loop over a commit range:
 * check out, boot the app, `reticle_crawl`, write the JSON here.
 */
async function handleHunt(dir: string): Promise<void> {
  try {
    const fs = createNodeFileSystem();
    const names: string[] = await fs.readdir(dir);
    const runs: HuntRun[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const raw = await fs.readFile(join(dir, name));
      if (raw === undefined) continue;
      const parsed: unknown = JSON.parse(raw);
      const report = parsed as { anomalies?: HuntAnomaly[]; stepsRun?: number; label?: string };
      runs.push({
        label: report.label ?? name.replace(/\.json$/, ''),
        anomalies: report.anomalies ?? [],
        ...(report.stepsRun === undefined ? {} : { stepsRun: report.stepsRun }),
      });
    }
    log('reticle_hunt', { ...summarizeHunt(runs) });
  } catch (error) {
    log('reticle_hunt_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Ensure a daemon is reachable on `port` (probe the real port; spawn + wait only if nothing's there). */
function ensureDaemon(port: number): Promise<void> {
  return probeDaemon(port).then(async (listening) => {
    // Attaching to whatever already owns the port is the whole point of a daemon — but it means an
    // upgrade does NOT take effect until that daemon dies, and nothing used to say so. Say it here,
    // where both versions are in hand, and keep attaching: killing another agent's daemon on a
    // version bump is worse than a loud warning.
    if (listening) return warnOnDaemonSkew(port);
    const scriptPath = process.argv[1];
    if (scriptPath === undefined) throw new Error('cannot locate the reticle daemon script');
    spawnDaemon(
      process.execPath,
      scriptPath,
      [DAEMON_INNER_COMMAND, PORT_FLAG, String(port)],
      port,
    );
    return waitForDaemon(port);
  });
}

/**
 * `reticle open [url]` — the one-command "show me the app". Resolves the port (the requested one if a
 * daemon's there, else a running daemon it discovers — so the user never hunts for the port), ensures
 * the daemon, then reuses the already-connected tab or opens a new browser at the url. Idempotent:
 * re-running never piles up duplicate tabs.
 */
/** How long `reticle open` waits for the launched page to register before reporting on it. */
const OPEN_SESSION_WAIT_MS = 8000;

/**
 * Poll until a NEW session shows up, or the wait runs out. Returns whether one did.
 *
 * Compares against the count taken before launching rather than against zero, so opening a second
 * app while one is already connected is not reported as an instant success.
 */
async function waitForNewSession(port: number, before: number): Promise<boolean> {
  const deadline = Date.now() + OPEN_SESSION_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { sessions } = summarizeStatus(await fetchStatus(port));
    if (sessions.length > before) return true;
  }
  return false;
}

function handleOpen(requestedPort: number, url: string | undefined): void {
  probeDaemon(requestedPort)
    .then((here) => (here ? requestedPort : (discoverDaemonPort() ?? requestedPort)))
    .then(async (port) => {
      await ensureDaemon(port);
      const { sessions } = summarizeStatus(await fetchStatus(port));
      const decision = decideOpen(sessions, url);
      if ('need-url' === decision.action) {
        log('reticle_open', {
          port,
          error:
            'no app connected — pass a url: reticle open <url>. Desktop app (Electron/Tauri)? ' +
            'There is no url to open: start it as you normally would and it connects to this bridge itself.',
        });
        return;
      }
      if ('reuse' === decision.action) {
        log('reticle_open', { port, reusing: decision.url });
        return;
      }
      // A tab on the right origin, on the WRONG page. Kept (that is what stops a tab piling up per
      // run) but never reported as done: `reusing` here read as "your url is open" for a page nobody
      // had opened.
      if ('left-as-is' === decision.action) {
        log('reticle_open', {
          port,
          reusing: decision.url,
          requested: decision.requested,
          note:
            `a tab is connected on this origin but sitting on ${decision.url} — it was LEFT THERE, ` +
            `not navigated to ${decision.requested}. Drive it with reticle_navigate, or open the url ` +
            'in the browser yourself.',
        });
        return;
      }
      const launchError = await openInBrowser(decision.url);
      if (launchError !== null) {
        log('reticle_open', {
          port,
          error: `could not launch a browser: ${launchError}`,
          recovery:
            'Open the url yourself, or run `reticle doctor` — it checks the pieces this command ' +
            'depends on.',
        });
        process.exit(1);
        return;
      }
      // Say whether a SESSION appeared, not merely that a launcher was invoked. `{"opened": url}`
      // was printed unconditionally, so a run where nothing ever opened looked identical to a run
      // where it did — reported from the field as twenty minutes lost to a phantom port problem.
      const connected = await waitForNewSession(port, sessions.length);
      log('reticle_open', {
        port,
        opened: decision.url,
        connected,
        ...(connected
          ? {}
          : {
              note:
                'the browser was launched but no Reticle session appeared. The app may still be ' +
                'loading, or it is not wired to this bridge — run `reticle doctor`, and check the ' +
                'app connects on port ' +
                String(port) +
                '.',
            }),
      });
    })
    .catch((err: unknown) => {
      log('reticle_open', { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
}

function handleDaemonInner(parsed: {
  port: number;
  driveUrl?: string;
  headless: boolean;
  http: boolean;
  httpPort?: number;
  httpToken?: string;
}): void {
  const options: StartOptions = {
    port: parsed.port,
    ...(parsed.driveUrl !== undefined
      ? { driveUrl: parsed.driveUrl, headless: parsed.headless }
      : {}),
    ...(parsed.http
      ? {
          httpVerify: true,
          ...(parsed.httpPort !== undefined ? { httpVerifyPort: parsed.httpPort } : {}),
          ...(parsed.httpToken !== undefined ? { httpVerifyToken: parsed.httpToken } : {}),
        }
      : {}),
  };

  startDaemon(options)
    .then((server) => {
      log('reticle_daemon_ready', { port: parsed.port, pid: process.pid });
      // Daemon lifecycle telemetry: started, a one-shot project profile, the periodic counter flush,
      // and the rich summary on shutdown. All of it lives in one module — see daemon-telemetry.ts.
      const daemonTelemetry = installDaemonTelemetry(process.cwd());
      // Publish to the discovery registry so a build plugin can find this daemon by projectId — no
      // hand-reconciled port. Written from the child (only it knows its cwd); removePid drops it.
      const registryProjectId = readProjectId(process.cwd());
      writeDaemonRegistry(parsed.port, {
        pid: process.pid,
        cwd: process.cwd(),
        startedAt: Date.now(),
        ...(registryProjectId !== undefined ? { projectId: registryProjectId } : {}),
      });
      // The daemon serves many agents — keep it alive through one agent's stray async error; only a
      // genuine uncaught throw takes it down (cleanly, so the next `reticle mcp` respawns it fresh).
      installDaemonResilience(process, log, () => {
        removePid(parsed.port);
        process.exit(1);
      });
      const shutdown = (reason: DaemonExitReason): void => {
        // Recorded BEFORE the async chain: `installExitTrace` reads it when Node is on its way out,
        // which is after everything below has run. Without it the exit line says `code: 0` and a
        // reader cannot tell a tidy stop from the bridge disappearing — see #123.
        recordExitReason(reason);
        // Awaited before the close/exit chain: `process.exit(0)` kills an in-flight POST, and this is
        // the one event carrying the whole session. A failed send resolves anyway (emit swallows its
        // own errors), so this can delay the exit by at most the send timeout, never prevent it.
        void daemonTelemetry
          .shutdown()
          .then(() => server.close())
          .then(() => {
            removePid(parsed.port);
            process.exit(0);
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            log('reticle_daemon_close_error', { error: message });
            removePid(parsed.port);
            process.exit(1);
          });
      };
      // Wrapped rather than passed directly: a signal handler receives the signal name as its first
      // argument, which would otherwise arrive as the reason.
      process.on('SIGTERM', () => shutdown(DaemonExitReason.SIGNAL));
      process.on('SIGINT', () => shutdown(DaemonExitReason.SIGNAL));
      // Self-shut-down when idle so a detached daemon (and any headless Chromium it launched) never
      // lingers on the user's machine after the editor closes. Reuses the same clean shutdown path.
      const attachedGraceEnv = process.env[ReticleEnv.IDLE_ATTACHED];
      const idleShutdown = new IdleShutdown({
        graceMs: resolveIdleShutdownMs(process.env[ReticleEnv.IDLE_SHUTDOWN]),
        checkIntervalMs: resolveIdleCheckMs(process.env[ReticleEnv.IDLE_CHECK]),
        isIdle: server.isIdle ?? (() => false),
        ...(server.agentAttached === undefined ? {} : { agentAttached: server.agentAttached }),
        // Only when the var is actually SET. `resolveIdleShutdownMs(undefined)` returns the 5-minute
        // DEFAULT, so passing it unconditionally would override the derived attached grace with the
        // very number this change exists to stop using — shipping the bug while looking fixed.
        ...(attachedGraceEnv === undefined || '' === attachedGraceEnv.trim()
          ? {}
          : { attachedGraceMs: resolveIdleShutdownMs(attachedGraceEnv) }),
        onShutdown: () => {
          log('reticle_daemon_idle_exit', { port: parsed.port });
          shutdown(DaemonExitReason.IDLE);
        },
      });
      idleShutdown.start();
      // Say so, regularly, so a GAP in this log is itself evidence. `installExitTrace` hooks
      // `'exit'`, which a SIGKILL never fires — so a killed daemon left nothing behind, and the one
      // that exited tidily logged `code: 0`. A reader could not tell "shut down cleanly" from "the
      // bridge every app on this machine needs is gone", and a correct SvelteKit install was written
      // up as an install failure on exactly that ambiguity. See daemon/heartbeat.ts.
      new DaemonHeartbeat({
        log,
        intervalMs: resolveHeartbeatMs(process.env[ReticleEnv.HEARTBEAT]),
        facts: () => ({
          sessions: server.bridge.sessions.count(),
          served: everServedToolCall(),
        }),
      }).start();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log('reticle_daemon_start_failed', { error: message });
      removePid(parsed.port);
      process.exit(1);
    });
}

/**
 * MCP proxy mode: ensures the daemon is running, then bridges Claude Code's
 * stdin/stdout to the daemon's SSE endpoint. This is the recommended way to
 * configure Reticle in.mcp.json — users never need to manage the daemon manually.
 *
 * Pass --drive <url> to have the daemon launch its own Playwright browser at that
 * URL. The agent then has full autonomous control without relying on the user's browser.
 */
function handleMcp(opts: {
  port: number;
  driveUrl?: string;
  headless: boolean;
  http: boolean;
  httpPort?: number;
  httpToken?: string;
}): void {
  const { port, driveUrl, headless, http, httpPort, httpToken } = opts;
  // The proxy IS the MCP server the editor launched. Nothing respawns it, so an uncaught throw here
  // is what a user experiences as "the MCP server disconnected — open /mcp and reconnect". Log it,
  // report it, keep serving: the reconnect and dormant paths already know how to rebuild the only
  // state this process has. See installProxyResilience for why its rule inverts the daemon's.
  // The proxy's crash handlers must write to the proxy's LOG FILE, not just stderr. The editor
  // swallows stderr, so wiring these to `log` meant a crash was handled and then unrecorded — the
  // failure a user reports as "it disconnected" left nothing behind to read.
  setProxyLogPort(port);
  installProxyResilience(process, proxyLog);
  /**
   * Make sure a daemon is on the port, spawning one if not.
   *
   * Called on first start AND on every reconnect. The proxy used to only retry the socket, so a
   * daemon that exited — crashed, `reticle stop`, or self-shut-down as idle — meant the retries hit
   * a dead port until the budget ran out and the agent's MCP server exited with it. Reticle simply
   * disappeared mid-session with nothing said. Respawning here makes the reconnect self-healing.
   */
  const ensure = async (): Promise<void> => {
    if (await probeDaemon(port)) return;
    const scriptPath = process.argv[1];
    if (scriptPath === undefined) {
      log('reticle_mcp_no_script', {});
      process.exit(1);
    }
    const daemonArgs = [DAEMON_INNER_COMMAND, PORT_FLAG, String(port)];
    if (driveUrl !== undefined) {
      daemonArgs.push(DRIVE_FLAG, driveUrl);
      if (!headless) daemonArgs.push(HEADED_FLAG);
    }
    // Forward the HTTP-verify flags too (previously silently dropped for `reticle mcp`).
    if (http) {
      daemonArgs.push(HTTP_FLAG);
      if (httpPort !== undefined) daemonArgs.push(HTTP_PORT_FLAG, String(httpPort));
      if (httpToken !== undefined) daemonArgs.push(HTTP_TOKEN_FLAG, httpToken);
    }
    spawnDaemon(process.execPath, scriptPath, daemonArgs, port);
    log('reticle_mcp_daemon_started', { port, ...(driveUrl !== undefined ? { driveUrl } : {}) });
    await waitForDaemon(port);
  };
  // Start the proxy WHATEVER happened to the daemon.
  //
  // This used to exit(1) when `ensure` failed, which is the third way an MCP server disappears on a
  // user: something else is holding the bridge port — a foreign daemon from another project, a
  // half-dead process, a port a colleague's tool grabbed — the spawned daemon cannot bind, and the
  // editor shows a server that failed to start. Nothing about that is unrecoverable: the proxy
  // answers `initialize` itself, serves the cached catalog, and its wake path retries a daemon on
  // every client request. Present-and-complaining beats absent, because absent needs a human.
  // `void`: the chain handles its own failure and the process must not wait on it — the proxy is
  // started from `finally` either way.
  void ensure()
    .catch((err: unknown) => {
      log('reticle_mcp_daemon_unavailable', {
        error: err instanceof Error ? err.message : String(err),
        note: 'serving anyway — the next tool call will try to start a daemon again',
      });
    })
    .finally(() => {
      // Also `void`: the proxy runs for the life of the process and is never awaited by anyone.
      //
      // The `.catch` is load-bearing despite that. `startMcpProxy` rejects when its FIRST connect
      // fails — which is precisely the case this block exists to tolerate, a daemon that is not
      // there yet — and with nothing attached that reject became an unhandledRejection. Reported
      // from a win32 user as a crash reading `connect ECONNREFUSED` with an EMPTY frame list,
      // because the stack of a refused socket is entirely node internals and the privacy filter
      // keeps only Reticle frames. So the one path we most want diagnosable arrived as an anonymous
      // crash. The proxy itself is unaffected — it has already installed its stdin reader and goes
      // on serving from cache, waking a daemon on the next request — which is exactly why this
      // must be logged as the expected condition it is rather than reported as a defect.
      void startMcpProxy(port, ensure).catch((err: unknown) => {
        log('reticle_mcp_proxy_first_connect_failed', {
          port,
          error: err instanceof Error ? err.message : String(err),
          note: 'serving from cache; the next client request will try to start a daemon',
        });
      });
    });
}

function handleLegacyDrive(parsed: { port: number; driveUrl: string; headless: boolean }): void {
  const options: StartOptions = {
    port: parsed.port,
    driveUrl: parsed.driveUrl,
    headless: parsed.headless,
  };
  start(options)
    .then(() => {
      log('reticle_started', { port: parsed.port });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log('reticle_start_failed', { error: message });
      process.exit(1);
    });
}

function main(): void {
  // Before anything reads process.env — notably the telemetry gate and the bridge's security
  // options — fold in a project-local `.env`. Values already in the environment always win.
  loadDotEnv(process.cwd());
  const argv = process.argv.slice(2);
  // Every invocation passes through here — the single chokepoint for the "how often is it used / how
  // many distinct machines + projects" metrics. Fire-and-forget: a metric must never delay or fail a run.
  //
  // `_daemon` is EXCLUDED, and that exclusion is the whole point of this branch. `reticle mcp` and
  // `reticle serve` start the daemon by re-running this very binary, so the child re-entered main()
  // and emitted a second event for what a person experienced as one action. The old `invoke` metric
  // was therefore inflated ~2x — and inflated worst on the agent-driven sessions that matter most,
  // while one-shot commands like `version` counted once. That skewed the RATIO between commands, not
  // just the scale, which is the kind of error you cannot correct for after the fact. The daemon's
  // own lifecycle is already reported by `daemon_started` / `daemon_stopped`; it is not a CLI run.
  reportCliRun(argv);
  // Cloud subcommands (login/link/project/config/push) are a distinct family with their own async client;
  // handle them before the local typed parser so `reticle login` etc. work as one tool.
  if (isCloudCommand(argv[0])) {
    void runCloudCommand(argv).then((code) => process.exit(code));
    return;
  }
  const portEnv = process.env[ReticleEnv.PORT];
  const envPort = portEnv !== undefined ? parseInt(portEnv, 10) : undefined;
  const projectPort = readProjectPort(process.cwd());
  // Say so rather than letting the daemon fight the dev server for the port and fail with an
  // EADDRINUSE that mentions neither file nor cause.
  if (projectPort !== undefined && isLikelyDevServerPort(projectPort)) {
    process.stderr.write(`${devServerPortWarning(projectPort)}\n`);
  }
  const defaultPort = envPort ?? projectPort ?? RETICLE_DEFAULT_PORT;
  // Headed by default; hidden only where there is no display to be headed on. A run nobody can see
  // is a run nobody trusts, and every "did it actually do anything?" cost a human round-trip.
  const parsed = parseCliArgs(argv, defaultPort, process.env['CI'] !== undefined);

  switch (parsed.kind) {
    case 'error':
      // Two audiences, two channels. The structured line is for logs and scripts; the plain text is
      // for the person who just typed the command. Emitting only the JSON meant a single typo came
      // back as an escaped one-line wall of the entire help text — see the ParseError builders.
      log('reticle_usage_error', { message: parsed.message });
      process.stderr.write(
        parsed.message === CLI_USAGE ? `${CLI_USAGE}\n` : `${parsed.message}\n\n${CLI_USAGE}\n`,
      );
      process.exit(1);
      break;
    case 'init':
      handleInit(parsed);
      break;
    case 'serve':
      handleServe(parsed);
      break;
    case 'stop':
      handleStop(parsed.port, parsed.quiet);
      break;
    case 'status':
      handleStatus(parsed.port);
      break;
    case 'license':
      handleLicense();
      break;
    case 'telemetry':
      handleTelemetry(parsed.action);
      break;
    case 'feedback':
      void handleFeedback(
        parsed.text,
        parsed.rating,
        parsed.bug,
        parsed.feedbackKind,
        parsed.agent,
      );
      break;
    case 'identify':
      void handleIdentify(parsed);
      break;
    case 'version':
      handleVersion();
      break;
    case 'help':
      process.stdout.write(`${CLI_USAGE}\n`);
      break;
    case 'doctor':
      void handleDoctor(parsed.port);
      break;
    case 'open':
      handleOpen(parsed.port, parsed.url);
      break;
    case 'drive':
      handleLegacyDrive(parsed);
      break;
    case 'verify':
      handleVerify(parsed);
      break;
    case 'capsules':
      void handleCapsules();
      break;
    case 'affected':
      void handleAffected(parsed.files, parsed.since);
      break;
    case 'hunt':
      void handleHunt(parsed.dir);
      break;
    case 'gate':
      void handleGate(parsed.files, parsed.since);
      break;
    case 'watch':
      handleWatch();
      break;
    case 'update':
      void handleUpdate();
      break;
    case 'rollback':
      void handleRollback();
      break;
    case 'mcp':
      handleMcp(parsed);
      break;
    case '_daemon':
      handleDaemonInner(parsed);
      break;
  }
}

/**
 * True when this module is the process entry point. Resolves argv[1] through the realpath because
 * package managers (notably pnpm) symlink `node_modules/<pkg>` into a store dir: the bin shim runs
 * `node node_modules/@reticlehq/core/dist/cli.js` (the symlink) while ESM `import.meta.url` is the
 * realpath. A plain string compare is false there, so `reticle <cmd>` would silently no-op.
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
