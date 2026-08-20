/**
 * A derived id for the wire contract this build speaks.
 *
 * Reticle is installed as separate pieces — the SDK in the page, the daemon, the MCP server the
 * agent spawns — upgraded independently and therefore drifting constantly. The question that
 * matters when they meet is not "are these the same release?" but "do these speak the same
 * contract?", and package-version equality answers it wrongly in both directions: it fires on
 * 2.4.0-vs-2.4.1 where nothing changed, and it stays silent for two different BUILDS of one version
 * number, which is exactly what a stale daemon and a cached npx package are.
 *
 * So this hashes the vocabulary itself. Both sides compute it from their own copy of core, so equal
 * hashes mean "we agree" whatever the version strings say, and a hash that moved means a name on the
 * wire genuinely changed.
 *
 * Derived on purpose. A hand-maintained contract number is one somebody eventually forgets to bump,
 * and a forgotten bump is silent skew — the failure this exists to end.
 */

import { ActionType, EventType, MessageKind, ReticleCommand } from './constants.js';

/**
 * FNV-1a, 32-bit. Chosen over a crypto hash because this runs in the PAGE: `crypto.subtle` is async
 * and unavailable on insecure origins, and a dependency is not worth 40 lines. Collisions do not
 * matter here — the comparison is equality between two builds of the same project, not a security
 * boundary.
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // The FNV prime, as shifts: Math.imul keeps this in 32-bit space in every JS engine.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Hash a named vocabulary. Keys and values are sorted, so declaration order — which changes for
 * cosmetic reasons — never moves the fingerprint, while a renamed, added or removed name always does.
 */
export function fingerprintOf(vocabulary: Record<string, readonly string[]>): string {
  const canonical = Object.keys(vocabulary)
    .sort()
    .map((key) => `${key}:${[...(vocabulary[key] ?? [])].sort().join(',')}`)
    .join('|');
  return fnv1a(canonical);
}

/**
 * The wire vocabulary two pieces must agree on to work together: the message kinds framing every
 * exchange, the commands the daemon sends the page, the actions it can ask for, and the event types
 * the page sends back. Everything else in core is shape, defaults or prose — it can change without
 * either side misunderstanding the other.
 */
export const CONTRACT_FINGERPRINT = fingerprintOf({
  messageKinds: Object.values(MessageKind),
  commands: Object.values(ReticleCommand),
  actions: Object.values(ActionType),
  events: Object.values(EventType),
});
