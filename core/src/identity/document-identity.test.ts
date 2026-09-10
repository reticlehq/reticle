import { describe, expect, it } from 'vitest';
import { DOCUMENT_ID_LENGTH, newDocumentId, isSameDocument } from './document-identity.js';

/**
 * Which document an observation belongs to.
 *
 * Evidence was scoped by time and by ring-buffer capacity and by nothing else, so a request observed
 * under a PREVIOUS document — or under a previous run of the application entirely — could be counted
 * against an action taken now. Field reports describe exactly that, including one where the failing
 * request Reticle cited named a database row that does not exist any more. The report was true about
 * the bytes and false about the world, which is the worst kind of wrong a verification tool can be.
 *
 * A document id is minted once per real document and dies with it. A full navigation replaces the
 * document and therefore the id; an SPA route change does NOT, which is correct — same JavaScript
 * context, same in-flight requests, same evidence.
 *
 * Randomness is injected rather than read here, for the same reason the clock is: a generator that
 * reaches for `Math.random()` cannot be tested and cannot be replayed.
 */

describe('newDocumentId', () => {
  it('is stable for one document and different across documents', () => {
    const a = newDocumentId(() => 0.5);
    const b = newDocumentId(() => 0.5);
    // Same seed, same id: the value is a pure function of what it was given, so a replay reproduces
    // it exactly rather than drifting.
    expect(a).toBe(b);
    expect(newDocumentId(() => 0.5)).not.toBe(newDocumentId(() => 0.9));
  });

  it('is short enough to stamp on every event', () => {
    // Stamped on EVERY event, so its cost is paid thousands of times per session. Long enough not to
    // collide within one session, short enough that the wire does not notice.
    expect(newDocumentId(() => 0.42)).toHaveLength(DOCUMENT_ID_LENGTH);
  });

  it('produces distinct ids across many documents', () => {
    let n = 0;
    const ids = new Set(Array.from({ length: 200 }, () => newDocumentId(() => (n++ % 97) / 97)));
    expect(ids.size).toBeGreaterThan(1);
  });

  it('never emits a character that would need escaping on the wire', () => {
    for (let i = 0; i < 50; i++) {
      expect(newDocumentId(() => i / 50)).toMatch(/^[0-9a-z]+$/);
    }
  });
});

describe('isSameDocument', () => {
  it('matches a document against itself', () => {
    expect(isSameDocument('abc123', 'abc123')).toBe(true);
  });

  it('rejects evidence minted under a superseded document', () => {
    expect(isSameDocument('abc123', 'def456')).toBe(false);
  });

  /**
   * The back-compat case, and the one where getting the default wrong is expensive in both
   * directions. An SDK older than this field stamps nothing.
   *
   * Unstamped evidence is treated as BELONGING to the current document. Excluding it would make an
   * older SDK silently stop reporting real contradictions — a verification tool that quietly finds
   * nothing is far worse than one that occasionally over-reports, and the whole point of this change
   * is to stop quietly-wrong answers rather than to trade one for another.
   */
  it('treats unstamped evidence as current, so an older SDK does not go silent', () => {
    expect(isSameDocument(undefined, 'abc123')).toBe(true);
    expect(isSameDocument('abc123', undefined)).toBe(true);
    expect(isSameDocument(undefined, undefined)).toBe(true);
  });
});
