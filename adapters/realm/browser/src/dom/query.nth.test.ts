import { describe, it, expect, beforeEach } from 'vitest';
import { matchQuery } from './query.js';
import { refs } from '@/dom/addressing/refs.js';
import { QueryBy } from '@reticlehq/core';

/**
 * A query answers with every match's COUNT but describes only a prefix of them, bounded by the
 * transport. A replay that must act on the recorded item of a long list (item 77 of 233 in a country
 * picker) could not reach it: the refs it received stopped at the prefix. `nth` asks for that one
 * match, wherever it is, and the count stays the count of every match.
 */
beforeEach(() => {
  document.body.innerHTML = '';
});

function list(n: number): HTMLButtonElement[] {
  document.body.innerHTML = Array.from(
    { length: n },
    (_, i) => `<button>Country</button><span>${String(i)}</span>`,
  ).join('');
  return Array.from(document.querySelectorAll('button'));
}

describe('a query with nth', () => {
  it('describes only the match at that position, past the described prefix', () => {
    const buttons = list(300);
    const result = matchQuery({ by: QueryBy.ROLE, value: 'button', name: 'Country', nth: 250 });
    expect(result.count).toBe(300);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.ref).toBe(refs.refFor(buttons[250] as HTMLElement));
  });

  it('describes nothing when the position is past the last match, and still counts every match', () => {
    list(3);
    const result = matchQuery({ by: QueryBy.ROLE, value: 'button', name: 'Country', nth: 5 });
    expect(result.count).toBe(3);
    expect(result.elements).toHaveLength(0);
  });

  it('leaves a query without nth as it was', () => {
    list(3);
    const result = matchQuery({ by: QueryBy.ROLE, value: 'button', name: 'Country' });
    expect(result.count).toBe(3);
    expect(result.elements).toHaveLength(3);
  });
});
