/**
 * Pure CLI argument parsing — the command/flag grammar, the CliResult union, and parseCliArgs.
 * Split out of cli.ts (which keeps the side-effecting handlers + dispatch) to stay under the
 * file-size cap and keep the parser pure + unit-testable. Re-exported from cli.ts so existing
 * imports are unchanged.
 */

export const CLI_USAGE = `usage:
  iris init  [--yes] [--dry-run] [--port N] [--no-mcp] [--no-install]  (wire Iris into the project in this directory)
  iris serve [--port N] [--drive <url>] [--headed] [--http] [--http-port N] [--http-token T]
  iris stop  [--port N] [--quiet]
  iris status [--port N]
  iris open  [url] [--port N]                        (show the app: reuse the connected tab, else open one)
  iris drive <url> [--headed]                       (foreground mode — for debugging)
  iris mcp   [--port N] [--drive <url>] [--headed]  (MCP stdio proxy — auto-starts daemon if needed)`;

const INIT_COMMAND = 'init';
const SERVE_COMMAND = 'serve';
const STOP_COMMAND = 'stop';
const STATUS_COMMAND = 'status';
const OPEN_COMMAND = 'open';
const DRIVE_COMMAND = 'drive';
const MCP_COMMAND = 'mcp';
export const DAEMON_INNER_COMMAND = '_daemon';

export const HEADED_FLAG = '--headed';
export const PORT_FLAG = '--port';
export const DRIVE_FLAG = '--drive';
const QUIET_FLAG = '--quiet';
const DRY_RUN_FLAG = '--dry-run';
const YES_FLAG = '--yes';
const NO_MCP_FLAG = '--no-mcp';
const NO_INSTALL_FLAG = '--no-install';
export const HTTP_FLAG = '--http';
export const HTTP_PORT_FLAG = '--http-port';
export const HTTP_TOKEN_FLAG = '--http-token';

export type CliResult =
  | { kind: 'init'; port: number | undefined; mcp: boolean; dryRun: boolean; install: boolean }
  | {
      kind: 'serve';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'stop'; port: number; quiet: boolean }
  | { kind: 'status'; port: number }
  | { kind: 'open'; port: number; url?: string }
  | {
      kind: '_daemon';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'drive'; port: number; driveUrl: string; headless: boolean }
  | { kind: 'mcp'; port: number; driveUrl?: string; headless: boolean }
  | { kind: 'error'; message: string };

type ServeFlags =
  | {
      kind: 'ok';
      port: number;
      driveUrl?: string;
      headless: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'error'; message: string };

function parseServeFlags(args: string[], defaultPort: number): ServeFlags {
  let port = defaultPort;
  let driveUrl: string | undefined;
  let headless = true;
  let http = false;
  let httpPort: number | undefined;
  let httpToken: string | undefined;
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
    } else if (arg === HTTP_FLAG) {
      http = true;
    } else if (arg === HTTP_PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) return { kind: 'error', message: CLI_USAGE };
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) return { kind: 'error', message: CLI_USAGE };
      httpPort = parsed;
    } else if (arg === HTTP_TOKEN_FLAG) {
      i++;
      httpToken = args[i];
      if (httpToken === undefined) return { kind: 'error', message: CLI_USAGE };
    } else {
      return { kind: 'error', message: CLI_USAGE };
    }
    i++;
  }
  return {
    kind: 'ok',
    port,
    headless,
    http,
    ...(driveUrl !== undefined ? { driveUrl } : {}),
    ...(httpPort !== undefined ? { httpPort } : {}),
    ...(httpToken !== undefined ? { httpToken } : {}),
  };
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
  if (argv.length === 0) return { kind: 'serve', port: defaultPort, headless: true, http: false };

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
        http: r.http,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
        ...(r.httpPort !== undefined ? { httpPort: r.httpPort } : {}),
        ...(r.httpToken !== undefined ? { httpToken: r.httpToken } : {}),
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
    case OPEN_COMMAND: {
      const port = parsePortFlag(rest, defaultPort);
      // The first non-flag arg is the url (optional — omitting reuses a connected tab).
      const url = rest.find((a) => !a.startsWith('--') && a !== String(port));
      return url !== undefined ? { kind: 'open', port, url } : { kind: 'open', port };
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
        http: r.http,
        ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
        ...(r.httpPort !== undefined ? { httpPort: r.httpPort } : {}),
        ...(r.httpToken !== undefined ? { httpToken: r.httpToken } : {}),
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
