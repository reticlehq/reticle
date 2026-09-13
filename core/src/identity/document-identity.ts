/**
 * Which document an observation belongs to.
 *
 * Evidence used to be scoped by time and by ring-buffer capacity and by nothing else. A request
 * observed under a PREVIOUS document — or under a previous run of the application entirely — could
 * therefore be counted against an action taken now. Field reports describe exactly that, including
 * one where the failing request Reticle cited named a database row that no longer exists: true about
 * the bytes, false about the world, which is the worst kind of wrong a verification tool can be.
 *
 * A document id is minted once per real document and dies with it. A full navigation replaces the
 * document and so replaces the id. An SPA route change does NOT, which is correct rather than a
 * limitation: same JavaScript context, same in-flight requests, same evidence.
 *
 * This lives in `core` because it crosses the wire, and every wire value is defined here.
 */

/**
 * Long enough not to collide within a session, short enough to stamp on every event.
 *
 * The cost is paid thousands of times per session, so this is a deliberate trade rather than a
 * default: eight base-36 characters is a little over forty bits, against a population of at most a
 * handful of documents per session. Collisions are not the risk being managed here; wire weight is.
 */
export const DOCUMENT_ID_LENGTH = 8;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Mint an id for the current document.
 *
 * `random` is injected for the same reason the clock is: a generator that reaches for `Math.random()`
 * cannot be unit-tested and cannot be replayed, and this repo forbids both.
 */
export function newDocumentId(random: () => number): string {
  let out = '';
  for (let i = 0; i < DOCUMENT_ID_LENGTH; i++) {
    const pick = Math.floor(random() * ALPHABET.length);
    // A generator returning exactly 1 (or a rounding artefact at the top of the range) would index
    // past the end and produce `undefined` in the string. Clamp rather than trust the caller.
    out += ALPHABET[Math.min(Math.max(pick, 0), ALPHABET.length - 1)];
  }
  return out;
}

/**
 * Does this evidence belong to the document currently under observation?
 *
 * **Unstamped evidence counts as current.** An SDK older than this field stamps nothing, and
 * excluding it would make those installations silently stop reporting real contradictions. A
 * verification tool that quietly finds nothing is far worse than one that occasionally over-reports,
 * and this change exists to remove quietly-wrong answers rather than to trade one kind for another.
 */
export function isSameDocument(
  evidenceDocumentId: string | undefined,
  currentDocumentId: string | undefined,
): boolean {
  if (undefined === evidenceDocumentId || undefined === currentDocumentId) return true;
  return evidenceDocumentId === currentDocumentId;
}
