import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adjudicate, Ground, type AdjudicationInput } from './spi/adjudicator.js';

/**
 * The published test vectors and the reference adjudicator say the same thing.
 *
 * WHY THE VECTORS EXIST. SPEC 7.1 is an eleven-clause decision procedure with eleven named grounds
 * and, until these landed, not one worked input/output pair. A stranger implementing the protocol
 * could read the order, believe they had understood it, and have no way to find out they had not.
 * Every failure mode a spec has comes down to two readers disagreeing about one sentence, and the
 * cure is not more sentences: it is a case they can both run.
 *
 * WHY THIS TEST EXISTS. A vector file that drifts from the implementation is worse than none, since
 * it sends an implementer confidently wrong and they have no reason to doubt it. These are generated
 * FROM the adjudicator and checked against it here, so the two cannot disagree: change the order and
 * this reddens until the vectors are regenerated, which is the moment to decide whether the change
 * was meant.
 *
 * Every ground must appear. A vector set that covers ten of eleven clauses is one an implementation
 * can pass while getting the missing clause wrong, and the missing one would be the clause nobody
 * thought about — which is the clause most likely to be wrong.
 */
interface Vector {
  readonly ground: string;
  readonly input: AdjudicationInput;
  readonly expected: { readonly verdict: string; readonly ground: string; readonly grade?: string };
}

const FILE = join(import.meta.dirname, '..', 'vectors', 'adjudication.json');
const vectors = (JSON.parse(readFileSync(FILE, 'utf8')) as { vectors: Vector[] }).vectors;

describe('the published adjudication vectors', () => {
  it('cover every ground the order can return', () => {
    // The join key between a spec sentence, a schema and a test. A ground with no vector is a clause
    // an implementation can fail silently.
    expect([...vectors.map((v) => v.ground)].sort()).toEqual([...Object.values(Ground)].sort());
  });

  it.each(vectors.map((v) => [v.ground, v] as const))(
    '%s — the reference adjudicator returns what the vector publishes',
    (_ground, vector) => {
      const got = adjudicate(vector.input);
      expect(got.ground).toBe(vector.expected.ground);
      expect(got.verdict).toBe(vector.expected.verdict);
      if (vector.expected.grade !== undefined) expect(got.grade).toBe(vector.expected.grade);
    },
  );

  it('names a reason on every vector, because a verdict nobody can argue with is not one', () => {
    for (const vector of vectors) {
      expect(adjudicate(vector.input).reasons.length, vector.ground).toBeGreaterThan(0);
    }
  });
});
