#!/usr/bin/env node
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { IRIS_DEFAULT_PORT } from '@syrin/iris-protocol';
import { start, startDaemon } from './index.js';
import { STATUS_PATH } from './http-server.js';
import { log } from './log.js';
import { readPid, isAlive, isRunning, removePid, spawnDaemon } from './daemon.js';
import { waitForDaemon, startMcpProxy, probeDaemon } from './mcp-proxy.js';
import { runInit } from './init/run.js';
import { buildNodeIo } from './init/node-io.js';
import type { StartOptions } from './index.js';

export const CLI_USAGE = `usage:
  iris init  [--yes] [--dry-run] [--port N] [--no-mcp] [--no-install]  (wire Iris into the project in this directory)
  iris serve [--port N] [--drive <url>] [--headed]
  iris stop  [--port N] [--quiet]
  iris status [--port N]
  iris drive <url> [--headed]                       (foreground mode — for debugging)
  iris mcp   [--port N] [--drive <url>] [--headed]  (MCP stdio proxy — auto-starts daemon if needed)`;

const INIT_COMMAND = 'init';
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
const DRY_RUN_FLAG = '--dry-run';
const YES_FLAG = '--yes';
const NO_MCP_FLAG = '--no-mcp';
const NO_INSTALL_FLAG = '--no-install';

export type CliResult =
  | { kind: 'init'; port: number | undefined; mcp: boolean; dryRun: boolean; install: boolean }
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

type InitFlags =
  | { kind: 'ok'; port: number | undefined; mcp: boolean; dryRun: boolean; install: boolean }
  | { kind: 'error'; message: string };

function parseInitFlags(args: string[]): InitFlags {
  let port: number | undefined;
  let mcp = true;
  let dryRun = false;
  let install = true;
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
    } else if (arg === NO_MCP_FLAG) {
      mcp = false;
    } else if (arg === NO_INSTALL_FLAG) {
      install = false;
    } else if (arg === DRY_RUN_FLAG) {
      dryRun = true;
    } else if (arg === YES_FLAG) {
      // Accepted for scripting/CI; init has no interactive prompts today.
    } else {
      return { kind: 'error', message: CLI_USAGE };
    }
    i++;
  }
  return { kind: 'ok', port, mcp, dryRun, install };
}

/** Pure CLI arg parser — exported for unit tests. argv = process.argv.slice(2). */
export function parseCliArgs(argv: string[], defaultPort: number): CliResult {
  if (argv.length === 0) return { kind: 'serve', port: defaultPort, headless: true };

  const [cmd, ...rest] = argv;

  switch (cmd) {
    case INIT_COMMAND: {
      const r = parseInitFlags(rest);
      if (r.kind === 'error') return r;
      return { kind: 'init', port: r.port, mcp: r.mcp, dryRun: r.dryRun, install: r.install };
    }
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

/** One connected tab as `iris status` reports it — the at-a-glance health line. */
interface StatusSession {
  sessionId: string;
  url: string;
  throttled: boolean;
  stale: boolean;
  pendingMarks: number;
}

/**
 * Reduce the daemon's /status JSON to the compact view `iris status` prints. Pure: narrows the
 * untrusted wire payload (never `any`) and tolerates a missing/partial body so a malformed response
 * degrades to "running, 0 sessions" instead of throwing.
 */
export function summarizeStatus(payload: unknown): {
  sessionCount: number;
  sessions: StatusSession[];
} {
  if (typeof payload !== 'object' || payload === null) return { sessionCount: 0, sessions: [] };
  const obj = payload as Record<string, unknown>;
  const raw = Array.isArray(obj['sessions']) ? obj['sessions'] : [];
  const sessions = raw
    .map((s): StatusSession | null => {
      if (typeof s !== 'object' || s === null) return null;
      const r = s as Record<string, unknown>;
      const sessionId = typeof r['sessionId'] === 'string' ? r['sessionId'] : '';
      if (sessionId === '') return null;
      return {
        sessionId,
        url: typeof r['url'] === 'string' ? r['url'] : '',
        throttled: r['throttled'] === true,
        stale: r['stale'] === true,
        pendingMarks: typeof r['pendingMarks'] === 'number' ? r['pendingMarks'] : 0,
      };
    })
    .filter((s): s is StatusSession => s !== null);
  const sessionCount =
    typeof obj['sessionCount'] === 'number' ? obj['sessionCount'] : sessions.length;
  return { sessionCount, sessions };
}

/** GET the daemon's /status JSON. Resolves to the parsed body, or undefined on any failure. */
function fetchStatus(port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: STATUS_PATH, timeout: 1000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
  });
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
