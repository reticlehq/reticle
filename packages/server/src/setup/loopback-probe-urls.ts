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
