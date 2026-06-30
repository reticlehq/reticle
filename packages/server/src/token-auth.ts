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
