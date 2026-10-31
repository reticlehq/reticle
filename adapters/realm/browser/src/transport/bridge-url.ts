/**
 * Whether, and where, a page may dial the Reticle bridge: the bridge path a hand-written URL needs,
 * and the rules for a remote page or bridge (wss, a pairing token).
 */
import {
  RETICLE_WS_PATH,
  TRANSPORT_LIMITS,
  isLocalPage,
  isLoopbackHostname,
} from '@reticlehq/core';

/**
 * The daemon only upgrades WebSocket connections on `RETICLE_WS_PATH`, so a hand-written bridge URL
 * with no path (`ws://localhost:4400`) would be answered with a silent 400. Give a pathless ws(s)
 * URL the bridge path; anything with an explicit path (a reverse proxy mount) is left alone.
 */
export function withBridgePath(bridgeUrl: string): { url: string; adjusted: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(bridgeUrl);
  } catch {
    return { url: bridgeUrl, adjusted: false };
  }
  if (
    (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    return { url: bridgeUrl, adjusted: false };
  }
  parsed.pathname = RETICLE_WS_PATH;
  return { url: parsed.toString(), adjusted: true };
}

export function connectionPolicy(
  pageHostname: string,
  bridgeUrl: string,
  allowNonLocalhost: boolean,
  token: string | undefined,
  /** The page's protocol. Desktop webviews (file:, app:, tauri:) are local despite a non-loopback host. */
  pageProtocol = 'http:',
): { allowed: boolean; reason?: string } {
  let bridge: URL;
  try {
    bridge = new URL(bridgeUrl);
  } catch {
    return { allowed: false, reason: 'invalid Reticle bridge URL' };
  }
  if (bridge.protocol !== 'ws:' && bridge.protocol !== 'wss:') {
    return { allowed: false, reason: 'Reticle bridge URL must use ws:// or wss://' };
  }
  if ((token?.length ?? 0) > TRANSPORT_LIMITS.MAX_TOKEN_LENGTH) {
    return {
      allowed: false,
      reason: `Reticle pairing token exceeds ${String(TRANSPORT_LIMITS.MAX_TOKEN_LENGTH)} characters`,
    };
  }
  const remoteBridge = !isLoopbackHostname(bridge.hostname);
  if (remoteBridge && bridge.protocol !== 'wss:') {
    return { allowed: false, reason: 'a non-local Reticle bridge must use wss://' };
  }
  const remote = !isLocalPage(pageProtocol, pageHostname) || remoteBridge;
  if (!remote) {
    return { allowed: true };
  }
  if (!allowNonLocalhost) {
    return {
      allowed: false,
      reason:
        'Reticle is disabled outside localhost unless allowNonLocalhost is explicitly enabled',
    };
  }
  if (token === undefined || 0 === token.length) {
    return { allowed: false, reason: 'a pairing token is required outside localhost' };
  }
  return { allowed: true };
}
