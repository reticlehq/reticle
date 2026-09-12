import { describe, expect, it } from 'vitest';
import { PredicateKind } from './consequence.js';
import { RunCheckSchema } from './verification-run.js';

/**
 * A check in the run artifact is named with the same word the assertion was written in.
 *
 * There used to be two spellings of one vocabulary. An assertion was written as `net`; the artifact
 * recorded it as `network`. Nobody translated between them, because nothing needed to until somebody
 * read both -- and then the same idea had two names and no rule for which to use.
 *
 * They had already drifted. `layout` existed in the artifact's list and in no assertion anybody could
 * write, so it could never be produced; `net` and `network` were the same thing spelled twice. That
 * is what a second copy of a vocabulary always turns into, which is why this repository's rules
 * forbid re-listing one.
 *
 * So the artifact now uses the assertion vocabulary directly. This check exists so a second copy
 * cannot come back: anything a person can assert must be recordable, in the same word.
 */
describe('a run artifact records checks in the vocabulary assertions are written in', () => {
  it('accepts every kind of assertion somebody can write', () => {
    const rejected: string[] = [];
    for (const kind of Object.values(PredicateKind)) {
      const parsed = RunCheckSchema.safeParse({ kind, predicate: 'anything', status: 'pass' });
      if (!parsed.success) rejected.push(kind);
    }
    expect(
      rejected,
      'These are kinds of assertion a person can write and the run artifact cannot record. A check ' +
        'that cannot be written down is a check nobody can read back.',
    ).toEqual([]);
  });

  it('translates the old spelling instead of storing it', () => {
    // A run written before this change is still readable -- reading it as empty would look like a
    // run that found nothing, which is the worse of the two failures. But it comes back in the new
    // vocabulary, so nothing downstream ever sees two words for one idea.
    const parsed = RunCheckSchema.safeParse({ kind: 'network', predicate: 'x', status: 'pass' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind).toBe(PredicateKind.NET);
  });

  it('refuses a word that is not a kind of assertion at all', () => {
    // The negative control. Without it the checks above would pass against a schema that accepts
    // any string, which is the same as having no vocabulary.
    expect(
      RunCheckSchema.safeParse({ kind: 'whatever', predicate: 'x', status: 'pass' }).success,
    ).toBe(false);
  });
});
