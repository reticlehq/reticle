import { describe, expect, it } from 'vitest';
import { GradeVerdict, gradeState, urlLine } from './grade-state.js';

const snap = (...lines: string[]) => ({ lines });

describe('gradeState', () => {
  it('passes when the candidate has the same lines as the reference', () => {
    const ref = snap('state order 1\tcanceled', 'state order 2\tpending');
    expect(gradeState(ref, ref, snap(...ref.lines)).verdict).toBe(GradeVerdict.PASS);
  });

  it('fails on a change to a record the task did not name', () => {
    const ref = snap('state order 1\tcanceled', 'state order 2\tpending');
    const result = gradeState(ref, ref, snap('state order 1\tcanceled', 'state order 2\tcanceled'));
    expect(result.verdict).toBe(GradeVerdict.FAIL);
    expect(result.removed).toEqual(['state order 2\tpending']);
    expect(result.added).toEqual(['state order 2\tcanceled']);
  });

  it('fails when the candidate has a row the reference does not, also a second copy of a row', () => {
    const ref = snap('state log a');
    expect(gradeState(ref, ref, snap('state log a', 'state log a')).added).toEqual(['state log a']);
  });

  it('ignores a line that differs between the two references', () => {
    const result = gradeState(
      snap('state p 1\t10', 'state seen monday'),
      snap('state p 1\t10', 'state seen tuesday'),
      snap('state p 1\t10', 'state seen wednesday'),
    );
    // The candidate's own noisy line is new, so it is a difference: noise covers only lines seen.
    expect(result.removed).toEqual([]);
    expect(result.added).toEqual(['state seen wednesday']);
    expect(result.ignored).toBe(1);
  });

  it('is unverified when a read failed, also when every snapshot failed the same way', () => {
    const failed = snap('state read failed: orders: ECONNREFUSED');
    const result = gradeState(failed, failed, failed);
    expect(result.verdict).toBe(GradeVerdict.UNVERIFIED);
    expect(result.unread).toHaveLength(3);
  });

  it('is linear in the rows: a source of 200,000 rows grades at once', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => `state p ${String(i)}`);
    const changed = [...rows.slice(0, -1), 'state p changed'];
    expect(gradeState({ lines: rows }, { lines: rows }, { lines: changed }).added).toEqual([
      'state p changed',
    ]);
  });
});

describe('urlLine', () => {
  it('removes the fragment and a final slash, and sorts the query values', () => {
    expect(urlLine('http://x/admin/sales/order/?b=2&a=1#top')).toBe(
      'url http://x/admin/sales/order?a=1&b=2',
    );
  });

  it('keeps text that is not a URL', () => {
    expect(urlLine(' not a url ')).toBe('url not a url');
  });
});
