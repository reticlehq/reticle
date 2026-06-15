#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { IRIS_DEFAULT_PORT } from '@syrin/iris-protocol';
import { start, startDaemon } from './index.js';
import { log } from './log.js';
import { readPid, isAlive, isRunning, removePid, spawnDaemon } from './daemon.js';
import { waitForDaemon, startMcpProxy, probeDaemon } from './mcp-proxy.js';
import type { StartOptions } from './index.js';

export const CLI_USAGE = `usage:
  iris serve [--port N] [--drive <url>] [--headed]
  iris stop  [--port N] [--quiet]
  iris status [--port N]
  iris drive <url> [--headed]                       (foreground mode — for debugging)
  iris mcp   [--port N] [--drive <url>] [--headed]  (MCP stdio proxy — auto-starts daemon if needed)`;

const SERVE_COMMAND = 'serve';
const STOP_COMMAND = 'stop';
const STATUS_COMMAND = 'status';
const DRIVE_COMMAND = 'drive';
const MCP_COMMAND = 'mcp';
const DAEMON_INNER_COMMAND = '_daemon';

const HEADED_FLAG = '--headed';
const PORT_FLAG = '--port';
const DRIVE_FLAG = '--drive';
const QUIET_FLAG = '--quiet';

export type CliResult =
  | { kind: 'serve'; port: number; driveUrl?: string; headless: boolean }
  | { kind: 'stop'; port: number; quiet: boolean }
  | { kind: 'status'; port: number }
  | { kind: '_daemon'; port: number; driveUrl?: string; headless: boolean }
  | { kind: 'drive'; port: number; driveUrl: string; headless: boolean }
  | { kind: 'mcp'; port: number; driveUrl?: string; headless: boolean }
  | { kind: 'error'; message: string };

type ServeFlags =
  | { kind: 'ok'; port: number; driveUrl?: string; headless: boolean }
  | { kind: 'error'; message: string };

function parseServeFlags(args: string[], defaultPort: number): ServeFlags {
  let port = defaultPort;
  let driveUrl: string | undefined;
  let headless = true;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return { kind: 'error', message: CLI_USAGE };
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return { kind: 'error', message: CLI_USAGE };
      port = parsed;
    } else if (arg === DRIVE_FLAG) {
      i++;
      driveUrl = args[i];
      if (driveUrl === undefined) return { kind: 'error', message: CLI_USAGE };
    } else if (arg === HEADED_FLAG) {
      headless = false;
    } else {
      return { kind: 'error', message: CLI_USAGE };
    }
    i++;
  }
  return { kind: 'ok', port, headless, ...(driveUrl !== undefined ? { driveUrl } : {}) };
}

function parsePortFlag(args: string[], defaultPort: number): number {
  const idx = args.indexOf(PORT_FLAG);
  if (idx === -1) return defaultPort;
  const n = args[idx + 1];
  if (n === undefined) return defaultPort;
  const parsed = parseInt(n, 10);
  return isNaN(parsed) ? defaultPort : parsed;
}

type DriveSuffix =
  | { kind: 'ok'; port: number; driveUrl: string; headless: boolean }
  | { kind: 'error'; message: string };

function parseDriveSuffix(args: string[], port: number): DriveSuffix {
  let headless = true;
  let driveUrl: string | undefined;
  for (const arg of args) {
    if (arg === HEADED_FLAG) {
      headless = false;
    } else if (arg.startsWith('--')) {
      return { kind: 'error', message: CLI_USAGE };
    } else if (driveUrl === undefined) {
      driveUrl = arg;
    } else {
      return { kind: 'error', message: CLI_USAGE };
    }
  }
  if (driveUrl === undefined) return { kind: 'error', message: CLI_USAGE };
  return { kind: 'ok', port, driveUrl, headless };
}

/** Pure CLI arg parser — exported for unit tests. argv = process.argv.slice(2). */
export function parseCliArgs(argv: string[], defaultPort: number): CliResult {
  if (argv.length === 0) return { kind: 'serve', port: defaultPort, headless: true };

  const [cmd, ...rest] = argv;

  switch (cmd) {
    case SERVE_COMMAND: {
      const r = parseServeFlags(rest, defaultPort);
      if (r.kind === 'error') return r;
      return {
        kind: 'serve',
        port: r.port,
        headless: r.headless,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
      };
    }
    case STOP_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      const quiet = rest.includes(QUIET_FLAG);
      return { kind: 'stop', port, quiet };
    }
    case STATUS_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      return { kind: 'status', port };
    }
    case DRIVE_COMMAND: {
      const r = parseDriveSuffix(rest, defaultPort);
      if (r.kind === 'error') return r;
      return { kind: 'drive', port: r.port, driveUrl: r.driveUrl, headless: r.headless };
    }
    case DAEMON_INNER_COMMAND: {
      const r = parseServeFlags(rest, defaultPort);
      if (r.kind === 'error') return r;
      return {
        kind: '_daemon',
        port: r.port,
        headless: r.headless,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
      };
    }
    case MCP_COMMAND: {
      const r = parseServeFlags(rest, defaultPort);
      if (r.kind === 'error') return r;
      return {
        kind: 'mcp',
        port: r.port,
        headless: r.headless,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
      };
    }
    default:
      return { kind: 'error', message: CLI_USAGE };
  }
}

function handleServe(parsed: { port: number; driveUrl?: string; headless: boolean }): void {
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
  spawnDaemon(process.execPath, scriptPath, daemonArgs, parsed.port);
  log('iris_daemon_spawned', { port: parsed.port });
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
  log('iris_status', { port, running: true, pid });
}

function handleDaemonInner(parsed: { port: number; driveUrl?: string; headless: boolean }): void {
  const options: StartOptions = {
    port: parsed.port,
    ...(parsed.driveUrl !== undefined
      ? { driveUrl: parsed.driveUrl, headless: parsed.headless }
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
  const portEnv = process.env['IRIS_PORT'];
  const defaultPort = portEnv === undefined ? IRIS_DEFAULT_PORT : parseInt(portEnv, 10);
  const parsed = parseCliArgs(process.argv.slice(2), defaultPort);

  switch (parsed.kind) {
    case 'error':
      log('iris_usage_error', { message: parsed.message });
      process.exit(1);
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
    case 'drive':
      handleLegacyDrive(parsed);
      break;
    case 'mcp':
      handleMcp(parsed);
      break;
    case '_daemon':
      handleDaemonInner(parsed);
      break;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
