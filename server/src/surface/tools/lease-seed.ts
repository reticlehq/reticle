/**
 * Seeded storage for a lease, and the errors a lease's navigation throws: what a caller may see of
 * them without seeing the secrets it seeded. Split from lease-tools.ts, which crossed the line cap.
 */
import { REDACTED_VALUE, scrubKnownSecrets, type SeedStorage } from '@reticlehq/core';

function redactExactValue(text: string, value: string): string {
  if (0 === value.length) return text;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(
    new RegExp(`(^|[^a-zA-Z0-9])${escaped}(?=$|[^a-zA-Z0-9])`, 'g'),
    `$1${REDACTED_VALUE}`,
  );
}

/**
 * Scrub known secret shapes and raw seedStorage values (cookies, localStorage, sessionStorage)
 * from an error string before it reaches daemon logs, metrics, or MCP error responses.
 */
export function scrubSeedFromError(text: string, seed?: unknown): string {
  let out = scrubKnownSecrets(text);
  if (undefined !== seed && null !== seed && 'object' === typeof seed) {
    const s = seed as Record<string, unknown>;
    const cookies = s['cookies'];
    if (undefined !== cookies && null !== cookies) {
      if (Array.isArray(cookies)) {
        for (const c of cookies) {
          if (undefined !== c && null !== c && 'object' === typeof c) {
            const val = (c as Record<string, unknown>)['value'];
            if (undefined !== val && 'string' === typeof val) {
              out = redactExactValue(out, val);
            }
          }
        }
      } else if ('object' === typeof cookies) {
        for (const v of Object.values(cookies as Record<string, unknown>)) {
          if ('string' === typeof v) {
            out = redactExactValue(out, v);
          }
        }
      }
    }
    const local = s['local'];
    if (undefined !== local && null !== local && 'object' === typeof local) {
      for (const v of Object.values(local as Record<string, unknown>)) {
        if ('string' === typeof v) {
          out = redactExactValue(out, v);
        }
      }
    }
    const session = s['session'];
    if (undefined !== session && null !== session && 'object' === typeof session) {
      for (const v of Object.values(session as Record<string, unknown>)) {
        if ('string' === typeof v) {
          out = redactExactValue(out, v);
        }
      }
    }
  }
  return out;
}

/** True for a Playwright `storageState()` export (`{ origins: [...] }`), not our seed shape. */
export function looksLikeStorageStateExport(seed: unknown): boolean {
  return Array.isArray((seed as { origins?: unknown } | null)?.origins);
}

/**
 * Turn a raw navigation failure (Playwright's `page.goto: net::ERR_… at <url>\nCall log:…`, often
 * with ANSI codes) into a short, clean reason — so the agent/user sees "is the app running?" instead
 * of an internals-leaking wall of text.
 */
/** What {@link cleanNavError} answers for a navigation that ran out of time. */
export const NAV_TIMED_OUT = 'navigation timed out';

export function cleanNavError(err: unknown, seed?: SeedStorage): string {
  const rawMsg = err instanceof Error ? err.message : String(err);
  const msg = scrubSeedFromError(rawMsg, seed);
  // Strip ANSI color codes (ESC[…m) Playwright emits — built via fromCharCode to keep the
  // control character out of a regex literal (no-control-regex).
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const firstLine = (msg.split('\n')[0] ?? msg).replace(ansi, '');
  const netCode = /net::[A-Z_]+/.exec(firstLine);
  if (netCode !== null) return netCode[0];
  if (/timeout/i.test(firstLine)) return NAV_TIMED_OUT;
  return firstLine
    .replace(/^page\.goto:\s*/, '')
    .replace(/\s+at\s+https?:\/\/\S+.*$/, '')
    .trim()
    .slice(0, 100);
}

/** The question a failed lease navigation asks, when nothing says the app is up. */
export const NAV_FAILED_QUESTION = 'is the app running there?';

/** What a lease navigation that ran out of time tells the caller to do. */
export const NAV_TIMEOUT_ADVICE =
  'If the app is running, a dev server compiling a route for the first time can take longer than ' +
  'that: retry the acquire. If it is not running, start it first.';

/** Lead of the timeout sentence, before the budget ("within 30 s", or "in time" when unknown). */
const NAV_TIMEOUT_LEAD = 'the page did not finish loading';
const NAV_TIMEOUT_UNKNOWN_BUDGET = 'in time';

/** Playwright's own wording for a navigation that ran out of time, with the budget it used. */
const PLAYWRIGHT_TIMEOUT = /Timeout (\d+)ms exceeded/;

/**
 * The sentence for a lease whose first navigation failed.
 *
 * A timeout and a refusal are different stories and get different sentences. A refusal
 * (`net::ERR_CONNECTION_REFUSED` and the like) means nothing is serving there, so asking whether the
 * app is running is the right question. A timeout proves less — only that the page was not ready in
 * time — and its most common cause is a dev server compiling a route for the first time, which
 * routinely outlasts the navigation budget. Asking "is the app running?" there sends the agent
 * hunting for a dev server that is up instead of retrying, so the timeout sentence names both
 * cases and leads with the retry.
 */
export function navFailureMessage(url: string, err: unknown, seed?: SeedStorage): string {
  const reason = cleanNavError(err, seed);
  if (NAV_TIMED_OUT !== reason) return `could not open ${url} — ${NAV_FAILED_QUESTION} (${reason})`;
  const rawMsg = err instanceof Error ? err.message : String(err);
  const budgetMs = PLAYWRIGHT_TIMEOUT.exec(rawMsg)?.[1];
  const within =
    budgetMs === undefined
      ? NAV_TIMEOUT_UNKNOWN_BUDGET
      : `within ${String(Number(budgetMs) / 1000)} s`;
  return `could not open ${url} — ${NAV_TIMEOUT_LEAD} ${within} (${reason}). ${NAV_TIMEOUT_ADVICE}`;
}

/**
 * Determine if a required seedStorage application precondition failed.
 *
 * Checks strong signals:
 * 1. HTTP 401/403 status on the initial navigation.
 * 2. Cross-origin redirect when localStorage or sessionStorage was requested (skipped by origin-scoping).
 * 3. Clear redirect to an authentication/login endpoint when the requested URL was not a login page.
 *
 * Normal app redirects (e.g. / → /dashboard) are valid and return undefined.
 */
export function evaluateSeedPrecondition(
  requestedUrl: string,
  actualUrl: string | undefined,
  seed: SeedStorage,
  navStatus?: number,
): string | undefined {
  if (401 === navStatus || 403 === navStatus) {
    return `HTTP ${navStatus} returned on initial seeded navigation to ${requestedUrl}`;
  }
  if (actualUrl === undefined || '' === actualUrl.trim()) return undefined;

  let reqParsed: URL | undefined;
  let actParsed: URL | undefined;
  try {
    reqParsed = new URL(requestedUrl);
    actParsed = new URL(actualUrl);
  } catch {
    return undefined;
  }

  // Cross-origin redirect when local or session storage was requested
  const hasStorage =
    (undefined !== seed.local && 0 < Object.keys(seed.local).length) ||
    (undefined !== seed.session && 0 < Object.keys(seed.session).length);
  if (hasStorage && reqParsed.origin !== actParsed.origin) {
    return `seeded storage precondition not established: cross-origin redirect from ${reqParsed.origin} to ${actParsed.origin} skipped origin-scoped storage injection`;
  }

  // Clear redirect to an authentication/login endpoint when the requested URL was not a login page
  const isAuthPath = (pathname: string): boolean =>
    /(?:^|\/)(?:login|signin|sign-in|auth\/login|auth\/signin|session\/new)(?:$|\/)/i.test(
      pathname,
    );

  if (!isAuthPath(reqParsed.pathname) && isAuthPath(actParsed.pathname)) {
    return `seeded authentication precondition not established: redirected from ${reqParsed.pathname} to login page (${actParsed.pathname})`;
  }

  return undefined;
}
