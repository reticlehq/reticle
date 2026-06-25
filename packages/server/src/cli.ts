#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { IRIS_DEFAULT_PORT, IrisEnv } from '@syrin/iris-protocol';
import { start, startDaemon } from './index.js';
import { log } from './log.js';
import {
  readPid,
  isAlive,
  isRunning,
  removePid,
  spawnDaemon,
  discoverDaemonPort,
} from './daemon.js';
import { waitForDaemon, startMcpProxy, probeDaemon } from './mcp-proxy.js';
import { fetchStatus, summarizeStatus, decideOpen, openInBrowser } from './cli-launch.js';
import { handleVerify } from './cli-verify.js';
import { runInit } from './init/run.js';
import { buildNodeIo } from './init/node-io.js';
import { describeLicense } from './license/license.js';
import { readProjectPort } from './cli-port.js';
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
} from './cli-parse.js';

// Re-exported so existing imports (and the CLI tests) keep resolving from './cli.js'.
export { parseCliArgs };
export { CLI_USAGE } from './cli-parse.js';
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
    log('iris_daemon_already_running', { port: parsed.port });
    return;
  }
  const scriptPath = process.argv[1];
  if (scriptPath === undefined) {
    log('iris_serve_no_script', {});
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
  log('iris_daemon_spawned', { port: parsed.port, ...(parsed.http ? { http: true } : {}) });
}

function handleStop(port: number, quiet: boolean): void {
  const pid = readPid(port);
  if (pid === null || !isAlive(pid)) {
    removePid(port);
    if (!quiet) log('iris_daemon_not_running', { port });
    return;
  }
  process.kill(pid, 'SIGTERM');
  const started = Date.now();
  const poll = setInterval(() => {
    if (!isAlive(pid)) {
      clearInterval(poll);
      removePid(port);
      if (!quiet) log('iris_daemon_stopped', { port, pid });
      return;
    }
    if (Date.now() - started > 5000) {
      clearInterval(poll);
      if (!quiet) log('iris_daemon_stop_timeout', { port, pid });
      process.exit(1);
    }
  }, 100);
}

function handleStatus(port: number): void {
  const pid = readPid(port);
  if (pid === null || !isAlive(pid)) {
    log('iris_status', { port, running: false });
    return;
  }
  // The daemon is up — ask it for live sessions + health so status is at-a-glance, not just a pid.
  void fetchStatus(port).then((payload) => {
    if (payload === undefined) {
      log('iris_status', { port, running: true, pid });
      return;
    }
    log('iris_status', { port, running: true, pid, ...summarizeStatus(payload) });
  });
}

/** `iris license` — show enterprise activation resolved from the environment (offline; nothing leaves). */
function handleLicense(): void {
  log('iris_license', { ...describeLicense(Date.now()) });
}

/** Ensure a daemon is reachable on `port` (probe the real port; spawn + wait only if nothing's there). */
function ensureDaemon(port: number): Promise<void> {
  return probeDaemon(port).then((listening) => {
    if (listening) return undefined;
    const scriptPath = process.argv[1];
    if (scriptPath === undefined) throw new Error('cannot locate the iris daemon script');
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
 * `iris open [url]` — the one-command "show me the app". Resolves the port (the requested one if a
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
        log('iris_open', { port, error: 'no app connected — pass a url: iris open <url>' });
        return;
      }
      if (decision.action === 'reuse') {
        log('iris_open', { port, reusing: decision.url });
        return;
      }
      openInBrowser(decision.url);
      log('iris_open', { port, opened: decision.url });
    })
    .catch((err: unknown) => {
      log('iris_open', { error: err instanceof Error ? err.message : String(err) });
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
      log('iris_daemon_ready', { port: parsed.port, pid: process.pid });
      const shutdown = (): void => {
        server
          .close()
          .then(() => {
            removePid(parsed.port);
            process.exit(0);
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            log('iris_daemon_close_error', { error: message });
            removePid(parsed.port);
            process.exit(1);
          });
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log('iris_daemon_start_failed', { error: message });
      removePid(parsed.port);
      process.exit(1);
    });
}

/**
 * MCP proxy mode: ensures the daemon is running, then bridges Claude Code's
 * stdin/stdout to the daemon's SSE endpoint. This is the recommended way to
 * configure Iris in .mcp.json — users never need to manage the daemon manually.
 *
 * Pass --drive <url> to have the daemon launch its own Playwright browser at that
 * URL. The agent then has full autonomous control without relying on the user's browser.
 */
function handleMcp(opts: { port: number; driveUrl?: string; headless: boolean }): void {
  const { port, driveUrl, headless } = opts;
  // Probe the port first — a daemon with a stale PID file is still usable.
  // Only spawn when nothing is actually listening on the port.
  probeDaemon(port)
    .then((listening) => {
      if (!listening) {
        const scriptPath = process.argv[1];
        if (scriptPath === undefined) {
          log('iris_mcp_no_script', {});
          process.exit(1);
          return;
        }
        const daemonArgs = [DAEMON_INNER_COMMAND, PORT_FLAG, String(port)];
        if (driveUrl !== undefined) {
          daemonArgs.push(DRIVE_FLAG, driveUrl);
          if (!headless) daemonArgs.push(HEADED_FLAG);
        }
        spawnDaemon(process.execPath, scriptPath, daemonArgs, port);
        log('iris_mcp_daemon_started', { port, ...(driveUrl !== undefined ? { driveUrl } : {}) });
      }
      return waitForDaemon(port).then(() => startMcpProxy(port));
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log('iris_mcp_proxy_error', { error: message });
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
      log('iris_started', { port: parsed.port });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log('iris_start_failed', { error: message });
      process.exit(1);
    });
}

function main(): void {
  const portEnv = process.env[IrisEnv.PORT];
  const envPort = portEnv !== undefined ? parseInt(portEnv, 10) : undefined;
  const projectPort = readProjectPort(process.cwd());
  const defaultPort = envPort ?? projectPort ?? IRIS_DEFAULT_PORT;
  const parsed = parseCliArgs(process.argv.slice(2), defaultPort);

  switch (parsed.kind) {
    case 'error':
      log('iris_usage_error', { message: parsed.message });
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
    case 'open':
      handleOpen(parsed.port, parsed.url);
      break;
    case 'drive':
      handleLegacyDrive(parsed);
      break;
    case 'verify':
      handleVerify(parsed);
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
 * `node node_modules/@syrin/iris/dist/cli.js` (the symlink) while ESM `import.meta.url` is the
 * realpath. A plain string compare is false there, so `iris <cmd>` would silently no-op.
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
