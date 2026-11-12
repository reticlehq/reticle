import { describe, expect, it } from 'vitest';
import { GradeVerdict, gradeState } from './grade-state.js';

describe('noise by cell', () => {
  // The defect: each correct run wrote its own time into order 302. The candidate wrote a third
  // time, so its line was new, and a correct run failed.
  it('ignores a third value in a cell that the two correct runs wrote differently', () => {
    const result = gradeState(
      { lines: ['state order 302\tcanceled\t02:38:01', 'state order 303\tpending\tx'] },
      { lines: ['state order 302\tcanceled\t02:41:07', 'state order 303\tpending\tx'] },
      { lines: ['state order 302\tcanceled\t02:44:55', 'state order 303\tpending\tx'] },
    );
    expect(result.verdict).toBe(GradeVerdict.PASS);
    expect(result.ignored).toBe(2);
  });

  it('fails a change to another cell of that row', () => {
    const result = gradeState(
      { lines: ['state order 302\tcanceled\t02:38:01'] },
      { lines: ['state order 302\tcanceled\t02:41:07'] },
      { lines: ['state order 302\tholded\t02:44:55'] },
    );
    expect(result.verdict).toBe(GradeVerdict.FAIL);
  });

  it('fails a change to the same cell of another row', () => {
    const result = gradeState(
      { lines: ['state order 302\tcanceled\t01', 'state order 303\tpending\t05'] },
      { lines: ['state order 302\tcanceled\t02', 'state order 303\tpending\t05'] },
      { lines: ['state order 302\tcanceled\t03', 'state order 303\tpending\t06'] },
    );
    expect(result.added).toEqual(['state order 303\tpending\t06']);
  });
});
