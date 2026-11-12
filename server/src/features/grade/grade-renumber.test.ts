import { describe, expect, it } from 'vitest';
import { renumber } from './grade-renumber.js';

const run = (reference: string[], candidate: string[]) => {
  const removed = reference.filter((l) => !candidate.includes(l));
  const added = candidate.filter((l) => !reference.includes(l));
  return renumber(removed, added, reference, candidate);
};

describe('renumber', () => {
  it('matches child rows written again with new ids, and the rows that link to them', () => {
    // The defect: a second save of product 78 wrote its links again as 2413-2414. The data was the
    // same, and a correct run failed on every link row.
    const reference = [
      'state link 2405\t78\t841',
      'state link 2406\t78\t606',
      'state link_pos 2408\t1\t2405\t1',
      'state link_pos 2409\t1\t2406\t2',
      'state product 78\tJacket\t10',
    ];
    const candidate = [
      'state link 2413\t78\t841',
      'state link 2414\t78\t606',
      'state link_pos 2416\t1\t2413\t1',
      'state link_pos 2417\t1\t2414\t2',
      'state product 78\tJacket\t10',
    ];
    expect(run(reference, candidate)).toEqual({ removed: [], added: [], renumbered: 4 });
  });

  it('keeps a changed value: a row written again with another value is a difference', () => {
    const result = run(['state link 2405\t78\t841'], ['state link 2413\t78\t842']);
    expect(result.renumbered).toBe(0);
    expect(result.added).toEqual(['state link 2413\t78\t842']);
  });

  it('keeps a change to a first column that is not an id', () => {
    // Stock 10 became 9 for product 78. Both values are also in other rows of the table.
    const reference = ['state stock 10\t78', 'state stock 9\t5', 'state stock 10\t6'];
    const candidate = ['state stock 9\t78', 'state stock 9\t5', 'state stock 10\t6'];
    expect(run(reference, candidate).renumbered).toBe(0);
  });

  it('keeps a row that moved to an id the reference already had', () => {
    const result = run(['state t 1\tx', 'state t 2\ty'], ['state t 2\tx']);
    expect(result.removed).toContain('state t 1\tx');
  });

  it('does not match rows of two tables', () => {
    expect(run(['state a 1\tx'], ['state b 2\tx']).renumbered).toBe(0);
  });
});
