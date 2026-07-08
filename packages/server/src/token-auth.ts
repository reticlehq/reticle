import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isLoopbackHostname } from '@reticlehq/protocol';

/** `Authorization: Bearer <token>` prefix and the query-param fallback for clients that can't set headers. */
const BEARER_PREFIX = 'Bearer ';
const TOKEN_QUERY_PARAM = 'token';
/** Node reports IPv4 loopback over a dual-stack socket as this mapped form; strip it before classifying. */
const IPV4_MAPPED_PREFIX = /^::ffff:/i;

/**
 * Timing-safe pairing-token comparison. Length-guards first because `timingSafeEqual` throws on a
 * length mismatch — and the guard itself is not a timing oracle (length is not the secret).
 */
export function tokensMatch(expected: string, received: string | undefined): boolean {
  if (received === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
}

/** Pull a request's pairing token from `Authorization: Bearer <t>` first, then a `?token=` query param. */
export function requestToken(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization;
  if (header !== undefined && header.startsWith(BEARER_PREFIX)) {
    return header.slice(BEARER_PREFIX.length);
  }
  const queryToken = url.searchParams.get(TOKEN_QUERY_PARAM);
  return queryToken !== null ? queryToken : undefined;
}

/** True when the request peer is a loopback address — the local-trust tier that needs no token. */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false;
  return isLoopbackHostname(remoteAddress.replace(IPV4_MAPPED_PREFIX, ''));
}

/** Extract the hostname from a `Host` value (`127.0.0.1:9000`) or a full origin/referer URL. */
function hostnameOf(value: string): string | undefined {
  const direct = value.includes('://') ? value : `http://${value}`;
  try {
    return new URL(direct).hostname;
  } catch {
    return undefined;
  }
}

/**
 * True when the `Host` header names a loopback host. This is the anti-DNS-rebinding guard: a rebound
 * page reaches us as a loopback *peer* but its browser still sends the attacker's original `Host`
 * (`evil.com`), so a non-loopback Host means "not actually a local client" even when the socket is.
 * Missing Host is untrusted — every real HTTP/1.1 client (incl. `reticle status`, the stdio proxy) sends it.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false;
  const hostname = hostnameOf(hostHeader);
  return hostname !== undefined && isLoopbackHostname(hostname);
}

/**
 * True when neither `Origin` nor `Referer` betrays a non-loopback web origin. Absent headers pass —
 * non-browser local clients (the stdio MCP proxy, `reticle status`) send neither. Any present-but-
 * non-loopback value fails, which is what kills a rebound `http://evil.com` page reading the plane.
 */
export function isLocalWebOrigin(origin: string | undefined, referer: string | undefined): boolean {
  for (const value of [origin, referer]) {
    if (value === undefined) continue;
    const hostname = hostnameOf(value);
    if (hostname === undefined || !isLoopbackHostname(hostname)) return false;
  }
  return true;
}
