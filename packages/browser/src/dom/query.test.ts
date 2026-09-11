import { describe, it, expect, beforeEach } from 'vitest';
import { runQuery } from './query.js';
import type { ElementQuery } from '@reticlehq/core';

/**
 * `by` is typed as the QueryBy union, so TypeScript alone would make this unreachable. It is not:
 * the value arrives as JSON off the wire, where the type system has no vote. The cast is how the
 * test reaches the runtime the product actually has.
 */
const offTheWire = (by: string, value: string): ElementQuery =>
  ({ by, value }) as unknown as ElementQuery;

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * The same guarantee, one layer down.
 *
 * The server now rejects an unknown `by` at the schema, but the browser is reachable by other paths
 * — replay, reticle_run, an internal caller — and its `default` arm used to `return []`. "No
 * matches" for a strategy that was never implemented is a false negative the tool invented, and it
 * looks exactly like the element being absent.
 */
describe('an unsupported query strategy throws instead of reporting zero matches', () => {
  it('throws, and names the strategies that do work', () => {
    document.body.innerHTML = '<button data-testid="b">Go</button>';
    expect(() => runQuery(offTheWire('css', 'button'))).toThrow(/unsupported query strategy/i);
    expect(() => runQuery(offTheWire('css', 'button'))).toThrow(/testid/);
  });

  it('a supported strategy still finds the element, so this is not just "everything throws"', () => {
    document.body.innerHTML = '<button data-testid="b">Go</button>';
    expect(runQuery({ by: 'testid', value: 'b' }).count).toBe(1);
  });
});
