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
} from './cli-flow-commands.js';
import { RETICLE_DEFAULT_PORT, ReticleDir, ReticleEnv } from '@reticlehq/core';
import { loadDotEnv } from './telemetry/dev-repo.js';
import { createNodeFileSystem } from './project/fs-port.js';
import { affectedSavedFlows } from './flows/flow-sources.js';

import { checkForUpdate } from './update/update-checker.js';
import { applyUpdate, rollback } from './update/updater.js';

import { start, startDaemon } from './index.js';
import { isCloudCommand, runCloudCommand } from './cloud-cli.js';
import { SERVER_VERSION } from './server-version.js';
import { log } from './log.js';
import {
  readPid,
  isAlive,
  isRunning,
  removePid,
  spawnDaemon,
  discoverDaemonPort,
  writeDaemonRegistry,
} from './daemon.js';
import { waitForDaemon, startMcpProxy, probeDaemon } from './mcp-proxy.js';
import { installDaemonResilience } from './daemon-resilience.js';
import { IdleShutdown, resolveIdleShutdownMs } from './idle-shutdown.js';
import { fetchStatus, summarizeStatus, decideOpen, openInBrowser } from './cli-launch.js';
import { handleVerify } from './cli-verify.js';
import { summarizeHunt, type HuntAnomaly, type HuntRun } from './hunt/hunt-report.js';
import { runInit } from './init/run.js';
import { handleDoctor } from './cli-doctor.js';
import { buildNodeIo } from './init/node-io.js';
import { describeLicense } from './license/license.js';
import { readProjectPort, readProjectId } from './cli-port.js';
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
} from './cli-parse.js';
import { handleFeedback, handleIdentify, handleTelemetry } from './telemetry/feedback-cli.js';
import { installDaemonTelemetry } from './telemetry/daemon-telemetry.js';
import { reportCliRun } from './telemetry/cli-telemetry.js';

// Re-exported so existing imports (and the CLI tests) keep resolving from './cli.js'.
export { parseCliArgs, CLI_USAGE };
export type { CliResult } from './cli-parse.js';

function handleInit(parsed: {
  port: number | undefined;
  mcp: boolean;
  dryRun: boolean;
  install: boolean;
}): void {
  const cwd = process.cwd();
  const result = runInit(
    { cwd, port: parsed.port, mcp: parsed.mcp, dryRun: parsed.dryRun, install: parsed.install },
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
  if (isRunning(parsed.port)) {
    log('reticle_daemon_already_running', { port: parsed.port });
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
  log('reticle_daemon_spawned', { port: parsed.port, ...(parsed.http ? { http: true } : {}) });
}

function handleStop(port: number, quiet: boolean): void {
  const pid = readPid(port);
  if (pid === null || !isAlive(pid)) {
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
  if (pid === null || !isAlive(pid)) {
    log('reticle_status', { port, running: false });
    return;
  }
  // The daemon is up — ask it for live sessions + health so status is at-a-glance, not just a pid.
  void fetchStatus(port).then((payload) => {
    if (payload === undefined) {
      log('reticle_status', { port, running: true, pid });
      return;
    }
    log('reticle_status', { port, running: true, pid, ...summarizeStatus(payload) });
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

/** `reticle update` — install the latest server version and restart (moved off the MCP surface). */
async function handleUpdate(): Promise<void> {
  try {
    const manifest = await checkForUpdate(SERVER_VERSION, () => Date.now());
    if (!manifest.updateAvailable || manifest.latestVersion === undefined) {
      log('reticle_update', {
        ok: false,
        message: 'already on the latest version',
        version: SERVER_VERSION,
      });
      return;
    }
    log('reticle_update', { ok: true, from: SERVER_VERSION, to: manifest.latestVersion });
    await applyUpdate(manifest.latestVersion); // calls process.exit; Claude Code restarts
  } catch (error) {
    log('reticle_update_failed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

/** `reticle rollback` — restore the previous server version and restart. */
async function handleRollback(): Promise<void> {
  try {
    await rollback(); // calls process.exit
  } catch (error) {
    log('reticle_rollback_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

/** Ensure a daemon is reachable on `port` (probe the real port; spawn + wait only if nothing's there). */
function ensureDaemon(port: number): Promise<void> {
  return probeDaemon(port).then((listening) => {
    if (listening) return undefined;
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
function handleOpen(requestedPort: number, url: string | undefined): void {
  probeDaemon(requestedPort)
    .then((here) => (here ? requestedPort : (discoverDaemonPort() ?? requestedPort)))
    .then(async (port) => {
      await ensureDaemon(port);
      const { sessions } = summarizeStatus(await fetchStatus(port));
      const decision = decideOpen(sessions, url);
      if (decision.action === 'need-url') {
        log('reticle_open', {
          port,
          error:
            'no app connected — pass a url: reticle open <url>. Desktop app (Electron/Tauri)? ' +
            'There is no url to open: start it as you normally would and it connects to this bridge itself.',
        });
        return;
      }
      if (decision.action === 'reuse') {
        log('reticle_open', { port, reusing: decision.url });
        return;
      }
      openInBrowser(decision.url);
      log('reticle_open', { port, opened: decision.url });
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
      const shutdown = (): void => {
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
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      // Self-shut-down when idle so a detached daemon (and any headless Chromium it launched) never
      // lingers on the user's machine after the editor closes. Reuses the same clean shutdown path.
      const idleShutdown = new IdleShutdown({
        graceMs: resolveIdleShutdownMs(process.env[ReticleEnv.IDLE_SHUTDOWN]),
        isIdle: server.isIdle ?? (() => false),
        onShutdown: () => {
          log('reticle_daemon_idle_exit', { port: parsed.port });
          shutdown();
        },
      });
      idleShutdown.start();
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
  // Probe the port first — a daemon with a stale PID file is still usable.
  // Only spawn when nothing is actually listening on the port.
  probeDaemon(port)
    .then((listening) => {
      if (!listening) {
        const scriptPath = process.argv[1];
        if (scriptPath === undefined) {
          log('reticle_mcp_no_script', {});
          process.exit(1);
          return;
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
        log('reticle_mcp_daemon_started', {
          port,
          ...(driveUrl !== undefined ? { driveUrl } : {}),
        });
      }
      return waitForDaemon(port).then(() => startMcpProxy(port));
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log('reticle_mcp_proxy_error', { error: message });
      process.exit(1);
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
  const defaultPort = envPort ?? projectPort ?? RETICLE_DEFAULT_PORT;
  const parsed = parseCliArgs(argv, defaultPort);

  switch (parsed.kind) {
    case 'error':
      log('reticle_usage_error', { message: parsed.message });
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
