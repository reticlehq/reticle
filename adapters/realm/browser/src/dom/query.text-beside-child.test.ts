/**
 * A text predicate finds text that is a bare text node next to a child element.
 *
 * Reported on 3.9.0: `{ kind: "text", contains: "problems to fix", visible: true }` read `no`
 * against `<span><span>DAILY CHECK</span>4 problems to fix.</span>`. The page's matcher finds
 * it; the false `no` came from the engine, which read a failed `match` reply as zero matches.
 * These tests pin the page's half: each shape matches, with and without a scope.
 */
import { describe, it, expect } from 'vitest';
import { ElementState, type ElementQuery } from '@reticlehq/core';
import { matchQuery } from './query.js';

const SCOPE = '[data-testid=fixes-summary]';

const SHAPES: Record<string, string> = {
  'text after a child':
    '<span><span>DAILY CHECK</span>4 problems to fix.</span><a href="#">Night Shift →</a>',
  'text before a child': '<span>4 problems to fix.<span>DAILY CHECK</span></span>',
  'text in several nodes': '<span><span>DAILY CHECK</span></span>',
  'text across several children':
    '<span><span>DAILY CHECK</span><b>4</b> problems <i>to</i> fix.</span>',
};

function render(shape: string): void {
  document.body.innerHTML = `<div data-testid="fixes-summary">${SHAPES[shape] ?? ''}</div>`;
  if ('text in several nodes' === shape) {
    // React writes `{count} problems to fix.` as two text nodes.
    document.querySelector('[data-testid=fixes-summary] span')?.append('4', ' problems to fix.');
  }
}

function matches(text: string, scope: string | undefined): boolean {
  const query: ElementQuery = { text, matchCase: true, ...(scope === undefined ? {} : { scope }) };
  return matchQuery(query, ElementState.VISIBLE).matched;
}

describe('a text check on text beside a child element', () => {
  for (const shape of Object.keys(SHAPES)) {
    for (const scope of [undefined, SCOPE]) {
      it(`matches ${shape}, scope ${scope ?? 'none'}`, () => {
        render(shape);
        expect(matches('problems to fix', scope)).toBe(true);
      });
    }
  }

  it('matches a phrase across the child boundary, as the page reads it', () => {
    render('text after a child');
    expect(matches('CHECK4 problems', undefined)).toBe(true);
    expect(matches('CHECK4 problems', SCOPE)).toBe(true);
  });
});
