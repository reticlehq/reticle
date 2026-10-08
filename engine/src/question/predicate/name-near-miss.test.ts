/**
 * A failed element predicate says which labels that role really has.
 *
 * `no element matched {role: "button", name: "Mesh"}` is byte-identical for a page with no such
 * button and for one showing `button "2 Mesh"`. The second is a one-call recovery and the first is
 * a bug report; `reticle_query` already tells them apart, and the predicate path did not (#875).
 */

import { describe, expect, it } from 'vitest';
import {
  ReticleCommand,
  type CommandResult,
  type MatchResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { describeNameNearMiss } from './name-near-miss.js';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

describe('describeNameNearMiss', () => {
  it('names the label that IS on the page', () => {
    const clause = describeNameNearMiss(['2 Mesh'], 'Mesh', 'button');

    expect(clause).toContain('"2 Mesh"');
    expect(clause).toContain('"Mesh"');
    expect(clause).toContain('EXACT');
  });

  it('names the role, because the hint is scoped to it', () => {
    // The browser will not offer a link as a recovery for a button. The sentence must not read as
    // if it might have.
    expect(describeNameNearMiss(['2 Mesh'], 'Mesh', 'button')).toContain('buttons');
  });

  it('says nothing when the page carried no near-miss label', () => {
    expect(describeNameNearMiss(undefined, 'Mesh', 'button')).toBeUndefined();
    expect(describeNameNearMiss([], 'Mesh', 'button')).toBeUndefined();
  });

  it('lists at most three, because beyond that it is a result set', () => {
    const many = Array.from({ length: 9 }, (_, i) => `${i} Mesh`);

    const clause = describeNameNearMiss(many, 'Mesh', 'button') ?? '';

    expect(clause).toContain('0 Mesh');
    expect(clause).not.toContain('3 Mesh');
  });

  it('truncates a long label rather than pasting a paragraph into a verdict', () => {
    const clause = describeNameNearMiss(['x'.repeat(200)], 'x', 'button') ?? '';

    expect(clause).toContain('…');
    expect(clause.length).toBeLessThan(220);
  });

  it('degrades when the caller knows no role', () => {
    const clause = describeNameNearMiss(['2 Mesh'], 'Mesh') ?? '';

    expect(clause).toContain('the page has');
    expect(clause).toContain('2 Mesh');
  });
});

/** A page with `button "2 Mesh"` and nothing named exactly "Mesh", as the browser reports the miss. */
class NearMissSession implements PredicateSession {
  command(name: string): Promise<CommandResult> {
    if (name !== ReticleCommand.MATCH) {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    const result: MatchResult = {
      matched: false,
      count: 0,
      elements: [],
      hint: {
        route: '/',
        presentTestids: [],
        presentRegions: [],
        knownEmptyState: false,
        nameNearMiss: ['2 Mesh'],
      },
    };
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 0;
  }
}

describe('a failed element predicate names the role in both spellings', () => {
  // The two spellings are one query to the browser, so they must be one sentence in the verdict.
  // The `by`/`value` form carries its role in `value`; reading only `query.role` said "the page
  // has" for a list the browser had already limited to buttons.
  it.each([
    ['{ role, name }', { role: 'button', name: 'Mesh' }],
    ["{ by: 'role', value, name }", { by: 'role', value: 'button', name: 'Mesh' }],
  ] as const)('%s', async (_label, query) => {
    const result = await evaluatePredicate(new NearMissSession(), { kind: 'element', query });

    expect(result.pass).toBe(false);
    expect(result.failureReason).toContain('"2 Mesh"');
    expect(result.failureReason).toContain("the page's buttons include");
    expect(result.failureReason).not.toContain('the page has');
  });
});
