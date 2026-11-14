import { describe, expect, it } from 'vitest';
import { DifferenceKind, compareReadings, lineDiff, type StepReading } from './compare-diff.js';

const read = (
  journey: number,
  step: number,
  lines: string[] | undefined,
  actions: string[] = [`act ${String(journey)}.${String(step)}`],
): StepReading => ({
  journey,
  step,
  actions,
  ...(lines === undefined ? {} : { lines }),
});

describe('lineDiff', () => {
  it('names the lines only on each side, by a longest common subsequence', () => {
    expect(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toEqual({
      removed: ['b'],
      added: ['x', 'd'],
    });
    expect(lineDiff(['a'], ['a'])).toEqual({ removed: [], added: [] });
  });
});

describe('compareReadings', () => {
  it('finds nothing when the candidate shows what the reference shows', () => {
    const ref = [read(0, 0, ['title', 'save'])];
    const result = compareReadings(ref, ref, ref);
    expect(result.differences).toEqual([]);
    expect(result.compared).toBe(1);
  });

  it('reports the changed lines of a step, with the actions that reached it', () => {
    const ref = [read(0, 0, ['title', 'save'], ['click "open"'])];
    const cand = [read(0, 0, ['title', 'store'], ['click "open"'])];
    const [only, ...rest] = compareReadings(ref, ref, cand).differences;
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      kind: DifferenceKind.CHANGED,
      actions: ['click "open"'],
      removed: ['save'],
      added: ['store'],
      seen: 1,
    });
    expect(only?.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('ignores a line that differs between the two reference runs', () => {
    const ref = [read(0, 0, ['clock 10:01', 'save'])];
    const again = [read(0, 0, ['clock 10:02', 'save'])];
    const cand = [read(0, 0, ['clock 10:03', 'save'])];
    const result = compareReadings(ref, again, cand);
    expect(result.differences).toEqual([]);
    expect(result.ignored).toBe(2);
  });

  // The cut line of a large state source carries a digest of the rows past the cap. Where `compare`
  // decides: a digest that only the candidate changes is a difference, and one that the two
  // reference runs disagree on is noise.
  it('reports a cut-rows digest that only the candidate changes', () => {
    const cut = (digest: string) => `state rows cut: big: kept 1000 of 2040, rest ${digest}`;
    const ref = [read(0, 0, [cut('aaaaaaaaaaaaaaaa')])];
    const cand = [read(0, 0, [cut('bbbbbbbbbbbbbbbb')])];
    expect(compareReadings(ref, ref, cand).differences).toHaveLength(1);
  });

  it('ignores a cut-rows digest that differs between the two reference runs', () => {
    const cut = (digest: string) => `state rows cut: big: kept 1000 of 2040, rest ${digest}`;
    const ref = [read(0, 0, [cut('aaaaaaaaaaaaaaaa')])];
    const again = [read(0, 0, [cut('bbbbbbbbbbbbbbbb')])];
    const cand = [read(0, 0, [cut('cccccccccccccccc')])];
    expect(compareReadings(ref, again, cand).differences).toEqual([]);
  });

  it('gives one id to the same lines seen at many steps, and counts them', () => {
    const ref = [read(0, 0, ['save']), read(0, 1, ['save', 'saved']), read(1, 0, ['save'])];
    const cand = [read(0, 0, ['store']), read(0, 1, ['store', 'saved']), read(1, 0, ['store'])];
    const differences = compareReadings(ref, ref, cand).differences;
    expect(differences).toHaveLength(1);
    expect(differences[0]?.seen).toBe(3);
    expect(differences[0]?.actions).toEqual(['act 0.0']);
  });

  it('gives the same id on every run, and a different id to different lines', () => {
    const ref = [read(0, 0, ['save'])];
    const a = compareReadings(ref, ref, [read(0, 0, ['store'])]).differences[0]?.id;
    const b = compareReadings(ref, ref, [read(0, 0, ['store'], ['other'])]).differences[0]?.id;
    const c = compareReadings(ref, ref, [read(0, 0, ['keep'])]).differences[0]?.id;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('reports a step the candidate could not do once, at the first step of its journey', () => {
    const ref = [read(0, 0, ['a']), read(0, 1, ['b']), read(0, 2, ['c'])];
    const cand = [read(0, 0, ['a']), read(0, 1, undefined)];
    const differences = compareReadings(ref, ref, cand).differences;
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({
      kind: DifferenceKind.UNREACHED,
      actions: ['act 0.1'],
      removed: [],
      added: [],
    });
  });

  it('does not report a step it could not do when the step before it already showed why', () => {
    const ref = [read(0, 0, ['open', 'save']), read(0, 1, ['saved'])];
    const cand = [read(0, 0, ['open', 'store']), read(0, 1, undefined)];
    const differences = compareReadings(ref, ref, cand).differences;
    expect(differences.map((d) => d.kind)).toEqual([DifferenceKind.CHANGED]);
  });

  it('compares nothing at a step the reference itself could not do, or did only once', () => {
    const ref = [read(0, 0, undefined), read(1, 0, ['x'])];
    const again = [read(0, 0, undefined), read(1, 0, undefined)];
    const cand = [read(0, 0, ['other']), read(1, 0, undefined)];
    const result = compareReadings(ref, again, cand);
    expect(result.differences).toEqual([]);
    expect(result.compared).toBe(0);
    expect(result.unstable).toBe(1);
  });
});
