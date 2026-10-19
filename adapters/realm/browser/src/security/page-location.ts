/**
 * The page's own address, as the wire may carry it.
 *
 * A magic-link or OAuth sign-in leaves `#access_token=…` in the address. Network URLs went through
 * `redactUrl`, but the route, the route events and the hello sent `location` raw, so a live session
 * token reached the agent's transcript. Every address the SDK sends comes from here.
 */
import { redactUrl } from '@reticlehq/core';

/** The full address, with a token in the query, the fragment or the authority redacted. */
export function pageHref(): string {
  return redactUrl(location.href);
}

/** The path, query and fragment, redacted the same way. */
export function pageRoute(withHash = true): string {
  return redactUrl(`${location.pathname}${location.search}${withHash ? location.hash : ''}`);
}
