import { IrisEnv } from '@syrin/iris-protocol';
import type { StartOptions } from './index.js';

/** The security contract the bridge/daemon enforce: bind host, pairing token, and WS origin allow-list. */
export interface BridgeSecurity {
  host?: string;
  token?: string;
  allowedOrigins?: string[];
}

/**
 * Resolve the bridge's security options from explicit options first, then the environment. Shared by
 * both `start()` and `startDaemon()` so the token/host/origin contract is enforced identically on
 * every entrypoint — a past divergence let daemon mode silently run with auth disabled.
 */
export function resolveBridgeSecurity(options: StartOptions): BridgeSecurity {
  const envToken = process.env[IrisEnv.TOKEN];
  const envOrigins = process.env[IrisEnv.ALLOWED_ORIGINS];
  const host = options.host ?? process.env[IrisEnv.HOST];
  const token =
    options.token ?? (envToken !== undefined && envToken.length > 0 ? envToken : undefined);
  const allowedOrigins =
    options.allowedOrigins ??
    envOrigins
      ?.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  return {
    ...(host === undefined ? {} : { host }),
    ...(token === undefined ? {} : { token }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  };
}
