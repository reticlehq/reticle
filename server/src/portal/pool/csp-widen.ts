/**
 * Let the zero-install reader dial the daemon from a page whose CSP does not allow it (#2016).
 *
 * The page keeps its own Content-Security-Policy. The rewrite adds one source, the daemon's
 * WebSocket origin, to `connect-src`, and changes nothing else. A bypass of page CSP would let a
 * lease pass where a real user hits a CSP block, which is a false green.
 *
 * The rewrite changes the page that the agent verifies, so it reports each change (`changed`, and
 * the `onWidened` call), and the lease result says `cspWidenedFor`.
 */

/** The result of a rewrite: the new text, and whether it differs from the text that came in. */
export interface CspRewrite {
  policy: string;
  changed: boolean;
}

const CONNECT_SRC = 'connect-src';
const DEFAULT_SRC = 'default-src';
const NONE_SOURCE = "'none'";
const CSP_HEADER = 'content-security-policy';
const DOCUMENT = 'document';

const tokensOf = (directive: string): string[] => directive.trim().split(/\s+/);
const nameOf = (directive: string): string => (tokensOf(directive)[0] ?? '').toLowerCase();

/** `name` plus its sources plus `origin`. `'none'` goes, because it is valid only alone. */
function withOrigin(name: string, sources: readonly string[], origin: string): string {
  const kept = sources.filter((s) => s.toLowerCase() !== NONE_SOURCE);
  return [name, ...kept, origin].join(' ');
}

/** One policy (no commas). Only the first `connect-src` counts; a browser ignores a repeat. */
function allowInOnePolicy(policy: string, origin: string): string {
  const directives = policy.split(';');
  const connect = directives.findIndex((d) => nameOf(d) === CONNECT_SRC);
  if (connect !== -1) {
    const [name = CONNECT_SRC, ...sources] = tokensOf(directives[connect] ?? '');
    if (sources.includes(origin)) {
      return policy;
    }
    const lead = /^\s*/.exec(directives[connect] ?? '')?.[0] ?? '';
    directives[connect] = `${lead}${withOrigin(name, sources, origin)}`;
    return directives.join(';');
  }
  const fallback = directives.find((d) => nameOf(d) === DEFAULT_SRC);
  if (fallback === undefined) {
    return policy;
  }
  const head = policy.replace(/[\s;]+$/, '');
  return `${head}; ${withOrigin(CONNECT_SRC, tokensOf(fallback).slice(1), origin)}`;
}

/**
 * Add `origin` to the `connect-src` of each policy in `policy`. A comma joins several policies,
 * and a browser enforces all of them, so each one gets the origin. A policy with no `connect-src`
 * and no `default-src` already allows the dial, and stays as it is.
 */
export function allowDaemonInCsp(policy: string, origin: string): CspRewrite {
  const next = policy
    .split(',')
    .map((one) => allowInOnePolicy(one, origin))
    .join(',');
  return { policy: next, changed: next !== policy };
}

const META_TAG = /<meta\b[^>]*>/gi;
const CSP_EQUIV = /\bhttp-equiv\s*=\s*["']?content-security-policy["']?(?=[\s/>])/i;
const CONTENT_ATTR = /(\bcontent\s*=\s*)("([^"]*)"|'([^']*)')/i;

/**
 * Apply `allowDaemonInCsp` to each `<meta http-equiv="Content-Security-Policy">` in `html`.
 * ponytail: reads the attribute text as it is; an entity-encoded quote inside it stays encoded.
 */
export function allowDaemonInHtml(
  html: string,
  origin: string,
): { html: string; changed: boolean } {
  const next = html.replace(META_TAG, (tag) => {
    if (!CSP_EQUIV.test(tag)) {
      return tag;
    }
    return tag.replace(CONTENT_ATTR, (_all, prefix: string, quoted: string) => {
      const quote = quoted.charAt(0);
      const widened = allowDaemonInCsp(quoted.slice(1, -1), origin).policy;
      return `${prefix}${quote}${widened}${quote}`;
    });
  });
  return { html: next, changed: next !== html };
}

/** The part of a Playwright `Route` the rewrite uses. A real `Route` satisfies it. */
export interface CspRoute<R extends CspResponse = CspResponse> {
  request(): { resourceType(): string; frame(): { parentFrame(): unknown } };
  fallback(): Promise<void>;
  fetch(opts: { maxRedirects: number }): Promise<R>;
  fulfill(opts: { response: R; headers?: Record<string, string>; body?: string }): Promise<void>;
}

/** The part of a Playwright `APIResponse` the rewrite uses. */
export interface CspResponse {
  headers(): Record<string, string>;
  headersArray(): { name: string; value: string }[];
  text(): Promise<string>;
}

function isTopDocument(route: CspRoute): boolean {
  const request = route.request();
  if (request.resourceType() !== DOCUMENT) {
    return false;
  }
  try {
    return null === request.frame().parentFrame();
  } catch {
    // A request with no frame (a service worker's own fetch) is no page the reader runs in.
    return false;
  }
}

/**
 * A route handler for a lease context: on the top document, add `origin` to its CSP header and
 * CSP meta tags, and call `onWidened` when that changed anything. Every other request goes on.
 * `Content-Security-Policy-Report-Only` blocks nothing, so it stays as the server sent it.
 */
export async function widenDocumentCsp<R extends CspResponse>(
  route: CspRoute<R>,
  origin: string,
  onWidened: () => void,
): Promise<void> {
  if (!isTopDocument(route)) {
    await route.fallback();
    return;
  }
  let response: R;
  try {
    // No redirects followed here: a redirect goes back to the browser, so the page URL stays true.
    response = await route.fetch({ maxRedirects: 0 });
  } catch {
    await route.fallback();
    return;
  }
  const policies = response
    .headersArray()
    .filter((h) => h.name.toLowerCase() === CSP_HEADER)
    .map((h) => h.value);
  const header = allowDaemonInCsp(policies.join(', '), origin);
  const isHtml = /html/i.test(response.headers()['content-type'] ?? '');
  const meta = isHtml ? allowDaemonInHtml(await response.text(), origin) : undefined;
  if (!header.changed && true !== meta?.changed) {
    await route.fulfill({ response });
    return;
  }
  const headers = { ...response.headers() };
  if (header.changed) {
    headers[CSP_HEADER] = header.policy;
  }
  if (true === meta?.changed) {
    // The new body is plain text: the old encoding and length describe a body that is gone.
    delete headers['content-encoding'];
    delete headers['content-length'];
    await route.fulfill({ response, headers, body: meta.html });
  } else {
    await route.fulfill({ response, headers });
  }
  onWidened();
}
