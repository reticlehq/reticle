import { describe, expect, it } from 'vitest';
import { PredicateKind } from './consequence.js';
import { RunCheckSchema } from './verification-run.js';

/**
 * A check in the run artifact is named with the same word the assertion was written in.
 *
 * Two spellings of one vocabulary drift: the same idea spelled `net` in an assertion and `network`
 * in the artifact, and a kind listed in the artifact that no assertion can produce. The artifact
 * uses the assertion vocabulary directly, and this check exists so a second copy cannot come back:
 * anything a person can assert must be recordable, in the same word.
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
