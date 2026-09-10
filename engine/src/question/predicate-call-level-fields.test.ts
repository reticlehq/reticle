/**
 * `timeout_ms` written inside `until`, and an error that named everything except where it goes.
 *
 * From a field session: `reticle_act_and_wait({ ref, action, until: { kind: "element", query, …,
 * timeout_ms: 45000 } })`. The reply was already good — it said the predicate did not parse, that
 * nothing ran, which fields `element` accepts, and showed a valid example. What it never said is
 * that `timeout_ms` is a real argument in the wrong place: it belongs to the CALL, beside `ref` and
 * `until`, not inside the predicate.
 *
 * That distinction is the whole retry. "Unknown field" reads as "there is no such thing", so the
 * obvious next move is to drop the field and lose the longer budget that was wanted — on a call that
 * had already timed out once at the default. Naming the destination turns a guess into a move.
 */
import { describe, expect, it } from 'vitest';
import { parsePredicate } from './predicate-parse.js';

const messageFor = (predicate: unknown): string => {
  try {
    parsePredicate(predicate);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : '';
  }
};

describe('a call-level argument written inside the predicate', () => {
  it('says timeout_ms belongs on the call, not in the predicate', () => {
    const message = messageFor({
      kind: 'element',
      query: { role: 'button', name: 'Save' },
      timeout_ms: 45000,
    });
    expect(message).toContain('timeout_ms');
    expect(message).toMatch(/belongs on the call|beside `until`|not inside/i);
  });

  it('names the other arguments that get nested by the same mistake', () => {
    for (const field of ['sessionId', 'ref', 'intent']) {
      expect(messageFor({ kind: 'element', query: { role: 'button' }, [field]: 'x' })).toContain(
        field,
      );
    }
  });

  it('still says what the kind DOES accept — the clause is added, not swapped', () => {
    const message = messageFor({
      kind: 'element',
      query: { role: 'button' },
      timeout_ms: 1000,
    });
    expect(message).toContain('element accepts:');
    expect(message).toContain('did not parse');
  });

  it('says nothing extra for a field that is simply misspelled', () => {
    // `urlContain` is nobody's argument. Offering it a home would be inventing one.
    const message = messageFor({ kind: 'net', urlContain: '/api' });
    expect(message).not.toMatch(/belongs on the call/i);
  });

  it('leaves a valid predicate alone', () => {
    expect(messageFor({ kind: 'element', query: { role: 'button', name: 'Save' } })).toBe('');
  });
});
