import { buildRedactionPolicy, type RedactionPolicy } from '@reticlehq/core';

/**
 * The redaction rule the DRIVEN path uses — the one place in the daemon that redacts a payload the
 * browser SDK never saw.
 *
 * ## Why this exists at all
 *
 * `connect({ redact: { keys } })` is configured in the page, and the SDK redacts everything it
 * observes. But a driven session's request bodies and response headers are captured by the daemon
 * straight from the network stack (`page.on('response')`), so they never pass through the SDK. An app
 * that declared `licenceKey` sensitive would see it redacted everywhere the developer looked, and
 * find it in cleartext in the on-disk journal — a leak on precisely the path they cannot inspect.
 * So a session's declared keys are announced in its hello and land here.
 *
 * ## Why a daemon-wide UNION rather than a per-session rule
 *
 * A NET_DETAIL is redacted at capture time and only routed to a session afterwards, by `pageUrl`.
 * At the moment of redaction there is no session in hand, and there is a real window in which there
 * is no session at all yet. Resolving one first would mean either delaying redaction (holding a raw
 * credential in memory until routing succeeds) or dropping the detail.
 *
 * The union sidesteps that, and is only safe because of an asymmetry that is enforced upstream:
 * declared keys can ONLY add redaction. The worst case is that one local app's declared key
 * over-redacts a same-named field in another local app on the same daemon — an inconvenience, in the
 * safe direction, between two apps belonging to the same developer on the same machine. The
 * dangerous direction is closed by construction: `allow` never crosses the bridge, so nothing a page
 * sends can lower this floor below the built-in rule.
 */

/** Declared keys per session id, so a disconnect narrows the union back down. */
const declaredBySession = new Map<string, readonly string[]>();

/** Memoized policy + the key set it was built from, so the hot path does not rebuild per response. */
let cached: { signature: string; policy: RedactionPolicy } | undefined;

function invalidate(): void {
  cached = undefined;
}

/** Record what a session declared sensitive. Called when its hello lands. */
export function declareDrivenRedactionKeys(sessionId: string, keys: readonly string[]): void {
  if (0 === keys.length) {
    if (declaredBySession.delete(sessionId)) invalidate();
    return;
  }
  declaredBySession.set(sessionId, [...keys]);
  invalidate();
}

/** Drop a session's declarations when it disconnects, so a closed tab stops widening the union. */
export function forgetDrivenRedactionKeys(sessionId: string): void {
  if (declaredBySession.delete(sessionId)) invalidate();
}

/** Every key declared by any connected session, sorted so the memo signature is stable. */
export function drivenRedactionKeys(): string[] {
  const all = new Set<string>();
  for (const keys of declaredBySession.values()) for (const key of keys) all.add(key);
  return [...all].sort();
}

/**
 * The rule in force for driven-path captures: the built-in rule plus every declared key. Identical
 * to the built-in rule when no session declared anything, which is the overwhelmingly common case
 * and the one that must stay byte-identical to before this feature existed.
 */
export function drivenRedactionPolicy(): RedactionPolicy {
  const keys = drivenRedactionKeys();
  const signature = keys.join('\u0000');
  if (cached?.signature !== signature) {
    cached = { signature, policy: buildRedactionPolicy({ keys }) };
  }
  return cached.policy;
}

/** Test seam: drop every declaration. Not used in production — sessions unregister themselves. */
export function resetDrivenRedaction(): void {
  declaredBySession.clear();
  invalidate();
}
