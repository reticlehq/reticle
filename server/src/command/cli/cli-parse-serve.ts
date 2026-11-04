/**
 * The serve / mcp / `_daemon` flag grammar, including the verify HTTP endpoint.
 *
 * Split out of `cli-parse.ts` when that file crossed the line cap. These three commands share one
 * flag set: the bridge port, a drive URL, headless, and the verify endpoint `--http` starts.
 */
import {
  HEADED_FLAG,
  IGNORE_HTTPS_ERRORS_FLAG,
  PORT_FLAG,
  missingValue,
  notANumber,
  unknownArgument,
  type ParseError,
} from './cli-parse-grammar.js';

/**
 * Force a hidden browser. The default is now HEADED: a run nobody can see is a run nobody trusts,
 * and every "did it actually do anything?" question cost a round-trip. CI passes this (or just sets
 * CI, which flips the default) because there is no display there to be headed on.
 */
export const HEADLESS_FLAG = '--headless';
export const DRIVE_FLAG = '--drive';
export const HTTP_FLAG = '--http';
export const HTTP_PORT_FLAG = '--http-port';
export const HTTP_TOKEN_FLAG = '--http-token';

type ServeFlags =
  | {
      kind: 'ok';
      port: number;
      driveUrl?: string;
      headless: boolean;
      /**
       * Accept a self-signed or local-CA dev certificate. The daemon passes this to the browser it
       * drives and to every context its lease pool opens (#1713).
       */
      ignoreHTTPSErrors?: boolean;
      http: boolean;
      httpPort?: number;
      httpToken?: string;
    }
  | { kind: 'error'; message: string };

const requiresHttp = (flag: string): ParseError => ({
  kind: 'error',
  message: `${flag} requires ${HTTP_FLAG} — it configures the verify endpoint ${HTTP_FLAG} starts`,
});

/**
 * The verify endpoint cannot use the bridge port.
 *
 * `reticle serve --http --http-port 4400` reached `listen` and died with a raw
 * `EADDRINUSE 127.0.0.1:4400`. That number is this daemon's bridge port, and MCP is already
 * served there. Name both ports and stop before anything listens (#1786).
 */
const httpPortIsBridge = (httpPort: number, bridgePort: number): ParseError => ({
  kind: 'error',
  message:
    `${HTTP_PORT_FLAG} ${String(httpPort)} is the bridge port ${String(bridgePort)}. ` +
    'Pick another port. MCP is already served on the bridge port.',
});

export function parseServeFlags(
  args: string[],
  defaultPort: number,
  defaultHeadless: boolean,
): ServeFlags {
  let port = defaultPort;
  let driveUrl: string | undefined;
  let headless = defaultHeadless;
  let ignoreHTTPSErrors = false;
  let http = false;
  let httpPort: number | undefined;
  let httpToken: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    // `i < args.length` already guarantees this, but the index signature does not say so and the
    // unknown-argument error needs a real string to name.
    if (arg === undefined) {
      break;
    }
    if (arg === PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) {
        return missingValue(PORT_FLAG);
      }
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) {
        return notANumber(PORT_FLAG, n);
      }
      port = parsed;
    } else if (arg === DRIVE_FLAG) {
      i++;
      driveUrl = args[i];
      if (driveUrl === undefined) {
        return missingValue(DRIVE_FLAG);
      }
    } else if (arg === HEADED_FLAG) {
      headless = false;
    } else if (arg === HEADLESS_FLAG) {
      headless = true;
    } else if (arg === IGNORE_HTTPS_ERRORS_FLAG) {
      ignoreHTTPSErrors = true;
    } else if (arg === HTTP_FLAG) {
      http = true;
    } else if (arg === HTTP_PORT_FLAG) {
      i++;
      const n = args[i];
      if (n === undefined) {
        return missingValue(HTTP_PORT_FLAG);
      }
      const parsed = parseInt(n, 10);
      if (isNaN(parsed)) {
        return notANumber(HTTP_PORT_FLAG, n);
      }
      httpPort = parsed;
    } else if (arg === HTTP_TOKEN_FLAG) {
      i++;
      httpToken = args[i];
      if (httpToken === undefined) {
        return missingValue(HTTP_TOKEN_FLAG);
      }
    } else {
      return unknownArgument(arg);
    }
    i++;
  }
  // Without `--http` these flags configure an endpoint nothing starts, and they were accepted and
  // silently ignored — worse than being rejected, because the whole reason to pass them is to be
  // honoured (#687).
  if (!http && httpPort !== undefined) {
    return requiresHttp(HTTP_PORT_FLAG);
  }
  if (!http && httpToken !== undefined) {
    return requiresHttp(HTTP_TOKEN_FLAG);
  }
  // `port` is the bridge port this command will bind. The caller passes the resolved default
  // (RETICLE_PORT, the project port, this project's daemon, or 4400). `--port` replaces it.
  if (httpPort !== undefined && httpPort === port) {
    return httpPortIsBridge(httpPort, port);
  }
  return {
    kind: 'ok',
    port,
    headless,
    ...(ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
    http,
    ...(driveUrl !== undefined ? { driveUrl } : {}),
    ...(httpPort !== undefined ? { httpPort } : {}),
    ...(httpToken !== undefined ? { httpToken } : {}),
  };
}
