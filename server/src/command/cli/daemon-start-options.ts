/**
 * Turn the parsed `_daemon` / `serve` flags into the options `startDaemon` takes.
 *
 * Extracted from `handleDaemonInner` to be testable, because the thing it got wrong was invisible
 * from outside: `headless` used to be spread INSIDE the `driveUrl !== undefined` branch, so
 * `reticle serve --headed` — no `--drive` — parsed the flag correctly and then dropped it on the
 * floor. `startDaemon` fell back to `headless ?? true` and the pool launched hidden, which reads to
 * a user as "--headed does nothing" and cost a real session of being told a run was visible when
 * four chrome-headless-shell processes said otherwise.
 *
 * `headless` and `driveUrl` are independent: the flag governs the shared browser POOL (leases,
 * replay, the spec runner), which exists whether or not a drive URL was named.
 */
import type { StartOptions } from '@/index.js';
import {
  DAEMON_INNER_COMMAND,
  DRIVE_FLAG,
  HEADED_FLAG,
  HEADLESS_FLAG,
  HTTP_FLAG,
  HTTP_PORT_FLAG,
  HTTP_TOKEN_FLAG,
  PORT_FLAG,
} from './cli-parse.js';

type DaemonFlags = {
  port: number;
  driveUrl?: string;
  headless: boolean;
  http: boolean;
  httpPort?: number;
  httpToken?: string;
};

export function daemonStartOptions(parsed: DaemonFlags): StartOptions {
  return {
    port: parsed.port,
    headless: parsed.headless,
    ...(parsed.driveUrl !== undefined ? { driveUrl: parsed.driveUrl } : {}),
    ...(parsed.http
      ? {
          httpVerify: true,
          ...(parsed.httpPort !== undefined ? { httpVerifyPort: parsed.httpPort } : {}),
          ...(parsed.httpToken !== undefined ? { httpVerifyToken: parsed.httpToken } : {}),
        }
      : {}),
  };
}

/**
 * The argv a parent hands its detached `_daemon` child.
 *
 * `serve` and `mcp` each built this list by hand and each made the SAME mistake as the options
 * builder above — pushing `--headed` only inside the `driveUrl` branch — so the flag survived
 * parsing, was dropped at the spawn, and the child launched a hidden pool. Three sites, one wrong
 * idea: that headless belongs to the drive URL. It belongs to the pool, which exists either way.
 */
export function daemonSpawnArgs(parsed: DaemonFlags): string[] {
  const args = [DAEMON_INNER_COMMAND, PORT_FLAG, String(parsed.port)];
  if (parsed.driveUrl !== undefined) args.push(DRIVE_FLAG, parsed.driveUrl);
  // Said either way: the child decides its own default from its environment, so a parent that
  // resolved hidden must say so rather than leave it to a default that may differ.
  args.push(parsed.headless ? HEADLESS_FLAG : HEADED_FLAG);
  if (parsed.http) {
    args.push(HTTP_FLAG);
    if (parsed.httpPort !== undefined) args.push(HTTP_PORT_FLAG, String(parsed.httpPort));
    if (parsed.httpToken !== undefined) args.push(HTTP_TOKEN_FLAG, parsed.httpToken);
  }
  return args;
}

/*
 * Whether a browser a daemon opens is shown or hidden when no flag says. Here because both callers that
 * decide it -- `cli.ts` and init's bring-up -- already start daemons through this module.
 */
/** Set (to anything but '', '0' or 'false') to hide every browser Reticle opens. Batteries set it. */
export const HEADLESS_ENV = 'RETICLE_HEADLESS';

/**
 * Whether a browser Reticle opens is hidden when no flag says. Shown by default, for every command:
 * the pool behind `serve`/`mcp` used to be hidden on the theory that nobody watches batch work, and
 * from the field that was a person watching an agent drive their app and seeing nothing happen.
 * Hidden where showing is impossible or unwanted: CI, the test batteries, and a Linux machine with
 * no display server, where a headed launch fails instead of showing anything.
 */
const OFF: ReadonlySet<string> = new Set(['', '0', 'false']);

export function headlessByDefault(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): boolean {
  const forced = env[HEADLESS_ENV];
  if (env['CI'] !== undefined || (forced !== undefined && !OFF.has(forced))) return true;
  return (
    'linux' === platform && env['DISPLAY'] === undefined && env['WAYLAND_DISPLAY'] === undefined
  );
}
