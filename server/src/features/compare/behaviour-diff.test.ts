import { describe, expect, it } from 'vitest';
import { CompareVerdict, DifferenceTag, compareBehaviour } from './behaviour-diff.js';
import type { BuildReadings, Reading } from './build-readings.js';

const read = (lines: string[], actions: string[] = ['open the start page']): Reading => ({
  actions,
  lines,
});
const failed = (failedAt: string): Reading => ({ actions: ['open the start page'], failedAt });
const build = (entries: Record<string, Reading>): BuildReadings => new Map(Object.entries(entries));

describe('compareBehaviour', () => {
  it('is the same when the only difference also differs between the two reference runs', () => {
    const result = compareBehaviour({
      order: ['a'],
      reference: build({ a: read(['shop', 'time 10:01']) }),
      again: build({ a: read(['shop', 'time 10:02']) }),
      candidate: build({ a: read(['shop', 'time 10:03']) }),
    });
    expect(result.verdict).toBe(CompareVerdict.SAME);
    expect(result.compared).toBe(1);
    expect(result.ignored).toBe(2);
  });

  it('ignores a live counter in every sequence once the reference runs showed it changing in one', () => {
    const result = compareBehaviour({
      order: ['a', 'b'],
      reference: build({ a: read(['ticker: 76']), b: read(['ticker: 80', 'total 4']) }),
      again: build({ a: read(['ticker: 77']), b: read(['ticker: 80', 'total 4']) }),
      candidate: build({ a: read(['ticker: 78']), b: read(['ticker: 81', 'total 5']) }),
    });
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({ removed: ['total 4'], added: ['total 5'] });
  });

  it('ignores a read that loaded, and still reports a read that failed and every write', () => {
    // A correct build was reported as different: its only difference was `net: GET /transactions.json 200`, a load
    // that one run made and the other did not (dashboard mutant m03, 2026-11-09). What a read loaded shows on the page.
    const ref = build({ a: read(['shop']) });
    const same = compareBehaviour({
      order: ['a'],
      reference: ref,
      again: ref,
      candidate: build({
        a: read(['shop', 'net: GET /transactions.json 200', 'net: GET /f.otf 304']),
      }),
    });
    expect(same.verdict).toBe(CompareVerdict.SAME);
    expect(same.ignored).toBe(2);
    const different = compareBehaviour({
      order: ['a'],
      reference: ref,
      again: ref,
      candidate: build({
        a: read(['shop', 'net: GET /api/items 500', 'net: POST /api/items 201 {}']),
      }),
    });
    expect(different.differences[0]?.added).toEqual([
      'net: GET /api/items 500',
      'net: POST /api/items 201 {}',
    ]);
  });

  it('reports a changed line once, with the steps that first reached it', () => {
    const ref = build({
      a: read(['total 4'], ['open the start page', 'click button "Add"']),
      b: read(['total 4', 'saved']),
    });
    const result = compareBehaviour({
      order: ['a', 'b'],
      reference: ref,
      again: ref,
      candidate: build({ a: read(['total 5']), b: read(['total 5', 'saved']) }),
    });
    expect(result.verdict).toBe(CompareVerdict.DIFFERENT);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({
      kind: 'changed',
      actions: ['open the start page', 'click button "Add"'],
      removed: ['total 4'],
      added: ['total 5'],
      seen: 2,
    });
  });

  it('reports a step the candidate cannot do once, by the step that failed', () => {
    const ref = build({ a: read(['x']), b: read(['y']) });
    const result = compareBehaviour({
      order: ['a', 'b'],
      reference: ref,
      again: ref,
      candidate: build({ a: failed('click button "Add"'), b: failed('click button "Add"') }),
    });
    expect(result.verdict).toBe(CompareVerdict.DIFFERENT);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({
      kind: 'unreached',
      failedAt: 'click button "Add"',
      seen: 2,
    });
  });

  it('does not compare a sequence the reference did on only one of its runs', () => {
    const result = compareBehaviour({
      order: ['a', 'b'],
      reference: build({ a: read(['x']), b: read(['y']) }),
      again: build({ a: read(['x']), b: failed('click button "Add"') }),
      candidate: build({ a: read(['x']), b: read(['z']) }),
    });
    expect(result.verdict).toBe(CompareVerdict.SAME);
    expect(result.unstable).toBe(1);
  });

  it('is invalid when nothing could be compared, because then nothing was proved', () => {
    const result = compareBehaviour({
      order: ['a'],
      reference: build({ a: failed('open the start page') }),
      again: build({ a: failed('open the start page') }),
      candidate: build({ a: read(['x']) }),
    });
    expect(result.verdict).toBe(CompareVerdict.INVALID);
    expect(result.referenceFailed).toBe(1);
  });

  it('with a base, tags each difference and scores the targets the candidate matched', () => {
    const ref = build({
      t1: read(['new title']),
      t2: read(['new total']),
      k1: read(['menu']),
      k2: read(['footer']),
    });
    const result = compareBehaviour({
      order: ['t1', 't2', 'k1', 'k2'],
      reference: ref,
      again: ref,
      base: build({
        t1: read(['old title']),
        t2: read(['old total']),
        k1: read(['menu']),
        k2: read(['footer']),
      }),
      candidate: build({
        t1: read(['new title']),
        t2: read(['old total']),
        k1: read(['menu', 'broken']),
        k2: read(['footer']),
      }),
    });
    expect(result.differences.map((d) => d.tag)).toEqual([
      DifferenceTag.TARGET_MISSED,
      DifferenceTag.REGRESSION,
    ]);
    expect(result.score).toEqual({ score: 0.25, targets: 2, matched: 1, kept: 2, changed: 1 });
  });

  it('tags a difference changed when the candidate differs from both the base and the reference', () => {
    const ref = build({ t: read(['new']) });
    const result = compareBehaviour({
      order: ['t'],
      reference: ref,
      again: ref,
      base: build({ t: read(['old']) }),
      candidate: build({ t: read(['other']) }),
    });
    expect(result.differences[0]?.tag).toBe(DifferenceTag.CHANGED);
    expect(result.score?.score).toBe(0);
  });

  it('reports a step that failed once on the candidate and passed on the retry, without changing the verdict', () => {
    // A retry must never hide an intermittent fault: it is listed beside the verdict, as evidence.
    const result = compareBehaviour({
      order: ['a'],
      reference: build({ a: read(['shop']) }),
      again: build({ a: read(['shop']) }),
      candidate: build({ a: { ...read(['shop']), retriedAt: 'select "Travel"' } }),
    });
    expect(result.verdict).toBe(CompareVerdict.SAME);
    expect(result.intermittent).toEqual([
      { actions: ['open the start page'], step: 'select "Travel"' },
    ]);
  });

  it('has no intermittent list when no step needed a retry', () => {
    const result = compareBehaviour({
      order: ['a'],
      reference: build({ a: read(['shop']) }),
      again: build({ a: read(['shop']) }),
      candidate: build({ a: read(['shop']) }),
    });
    expect(result.intermittent).toBeUndefined();
  });
});
