import { ReticleEnv } from '@reticlehq/core';
import type { StartOptions } from './index.js';
import {
  defaultPairingTokenDir,
  nodePairingTokenDeps,
  readOrCreatePairingToken,
} from './pairing-token.js';
import { log } from './log.js';

/** The security contract the bridge/daemon enforce: bind host, pairing token, and WS origin allow-list. */
interface BridgeSecurity {
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
  const envToken = process.env[ReticleEnv.TOKEN];
  const envOrigins = process.env[ReticleEnv.ALLOWED_ORIGINS];
  const host = options.host ?? process.env[ReticleEnv.HOST];
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

/**
 * Same as `resolveBridgeSecurity`, but when no explicit/env token is set it auto-provisions one from
 * ~/.reticle/pairing-token so the bridge always requires a secret by default — this is what closes the
 * "any loopback origin is trusted" gap (a rogue localhost app can't read the file to present it). The
 * build plugins read the same file and inject it, so plugin-served apps stay zero-config. Best-effort:
 * if provisioning fails, the daemon degrades to the prior tokenless behavior rather than failing to start.
 */
export async function resolveBridgeSecurityWithAutoToken(
  options: StartOptions,
): Promise<BridgeSecurity> {
  const security = resolveBridgeSecurity(options);
  if (security.token !== undefined) return security;
  const dir = options.pairingTokenDir ?? defaultPairingTokenDir();
  const token = await readOrCreatePairingToken(dir, nodePairingTokenDeps());
  if (token === undefined) {
    log('pairing_token_provision_failed', { dir });
    return security;
  }
  return { ...security, token };
}
