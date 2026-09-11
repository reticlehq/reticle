/**
 * Both spellings of one role+name query explain a miss the same way.
 *
 * `findIn` resolves `{ by: 'role', value, name }` and `{ role, name }` through one function, and
 * says so in its own comment: "the two forms must not disagree about what is findable". The
 * near-miss hint read only the first, so the structured spelling missed in silence while the
 * by/value spelling explained itself -- same query, same page, two answers (#875).
 *
 * The structured form is the one a predicate carries, which is why the gap was invisible: the
 * spelling most likely to be written by hand is the one that explained itself.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { runQuery } from './query.js';
import { QueryBy } from '@reticlehq/core';

beforeEach(() => {
  document.body.innerHTML = '';
});

const near = (result: ReturnType<typeof runQuery>): string[] => result.hint?.nameNearMiss ?? [];

describe('the structured role+name spelling', () => {
  it('answers a miss with the label that role really has', () => {
    document.body.innerHTML = '<button>2 Mesh</button><button>Solve</button>';

    const result = runQuery({ role: 'button', name: 'Mesh' });

    expect(result.count).toBe(0);
    expect(near(result)).toContain('2 Mesh');
  });

  it('agrees with the by/value spelling of the same query', () => {
    document.body.innerHTML = '<button>New boundary from 1 selected surface</button>';

    const structured = near(runQuery({ role: 'button', name: 'New boundary from' }));
    const byValue = near(
      runQuery({ by: QueryBy.ROLE, value: 'button', name: 'New boundary from' }),
    );

    expect(structured).toEqual(byValue);
    expect(structured).toEqual(['New boundary from 1 selected surface']);
  });

  it('answers when the asked-for name is the longer string', () => {
    document.body.innerHTML = '<button>Save</button>';

    expect(near(runQuery({ role: 'button', name: 'Save changes' }))).toEqual(['Save']);
  });
});

describe('widening the spelling does not widen the hint', () => {
  it('stays scoped to the requested role', () => {
    // A link called "2 Mesh" is not a recovery for a BUTTON called "Mesh": pointing at it would
    // recommend acting on a different control, which is what keeping the match exact avoids.
    document.body.innerHTML = '<a href="#">2 Mesh</a>';

    expect(near(runQuery({ role: 'button', name: 'Mesh' }))).toEqual([]);
  });

  it('says nothing when no label is close', () => {
    document.body.innerHTML = '<button>Solve</button>';

    expect(runQuery({ role: 'button', name: 'Mesh' }).hint?.nameNearMiss).toBeUndefined();
  });

  it('says nothing for a query that named no role', () => {
    document.body.innerHTML = '<button>2 Mesh</button>';

    expect(runQuery({ by: QueryBy.TESTID, value: 'nope' }).hint?.nameNearMiss).toBeUndefined();
  });

  it('does not treat an empty name as close to everything', () => {
    document.body.innerHTML = '<button>2 Mesh</button>';

    expect(runQuery({ role: 'button', name: '' }).hint?.nameNearMiss).toBeUndefined();
  });
});
