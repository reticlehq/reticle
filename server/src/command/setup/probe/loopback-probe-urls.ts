/**
 * Alternate loopback URLs to try when a readiness probe misses on the announced host.
 *
 * Vite (and friends) sometimes print `http://127.0.0.1:PORT` even when the process only accepted
 * on `[::1]`. Node `fetch` of that announcement then fails forever while `http://localhost:PORT`
 * and `http://[::1]:PORT` answer — which is how `init` sat in the wait loop until something killed
 * it (#884). Asking by name hands the family to the OS; asking both literal loopbacks does not.
 *
 * Same "either family is enough" rule as `PROBE_HOSTS` in the no-session diagnostic — this is the
 * setup wait's copy of that lesson, applied to a full URL rather than a bare port.
 */

import { isLoopbackHostname } from '@reticlehq/core';

/** Hosts to try, in order: keep the caller's first, then fill the gaps. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

/**
 * URLs that mean the same loopback listener, for every family this machine might bind.
 *
 * Non-loopback URLs are returned unchanged (one candidate): a LAN or tunnel origin is not a
 * family-split problem, and inventing alternates would probe the wrong machine.
 */
export function loopbackProbeUrls(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  if (!isLoopbackHostname(parsed.hostname)) return [url];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (host: string): void => {
    const next = new URL(parsed.href);
    // `URL.hostname = '::1'` is a silent no-op in Node — the IPv6 form has to go through `host`
    // with brackets, or the candidate list collapses to IPv4-only and the whole fallback is dead.
    const port = parsed.port;
    next.host = host.includes(':')
      ? `[${host}]${port.length > 0 ? `:${port}` : ''}`
      : `${host}${port.length > 0 ? `:${port}` : ''}`;
    const href = next.href;
    if (seen.has(href)) return;
    seen.add(href);
    out.push(href);
  };

  // Caller's host first so a working announcement is not reordered for no reason.
  push(parsed.hostname);
  for (const host of LOOPBACK_HOSTS) push(host);
  return out;
}

/**
 * Errors that mean "nothing is listening at THIS address", so another loopback family may be.
 *
 * Anything else, a timeout above all, means the address was right and the server is slow. A cold
 * Next 16 first compile takes long enough to time a probe out, and treating that as a family miss
 * walked on to `127.0.0.1`/`[::1]`, which answered first, became the app url, and is an origin Next
 * refuses its dev resources to: no hydration, so the SDK never ran and init blamed the page.
 */
const ADDRESS_MISS_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'EADDRNOTAVAIL',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAFNOSUPPORT',
]);

function field(value: unknown, key: string): unknown {
  return 'object' === typeof value && null !== value ? Reflect.get(value, key) : undefined;
}

const codeOf = (value: unknown): string | undefined => {
  const code = field(value, 'code');
  return 'string' === typeof code ? code : undefined;
};

/**
 * Whether a failed fetch was refused at the connection level on this address.
 *
 * `fetch` wraps the socket error as `cause`; with happy-eyeballs that cause is an AggregateError of
 * one error per address tried, and it is a miss only when every one of them was.
 */
export function isAddressMiss(err: unknown): boolean {
  const cause = field(err, 'cause');
  const direct = codeOf(cause);
  if (undefined !== direct) return ADDRESS_MISS_CODES.has(direct);
  const errors = field(cause, 'errors');
  if (!Array.isArray(errors) || 0 === errors.length) return false;
  return errors.every((e: unknown) => ADDRESS_MISS_CODES.has(codeOf(e) ?? ''));
}
