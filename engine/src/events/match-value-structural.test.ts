/**
 * `equals` against an array or an object could never pass, whatever the app did.
 *
 * `matchValue` ends in `got === want`, which is reference equality, and a predicate's expected value
 * is a literal parsed out of the agent's JSON — a different object every time. So
 * `{ kind: "state", path: "items", equals: ["a", "b"] }` was false even when the store held exactly
 * `["a", "b"]`. Not a false green: the mirror of one, an assertion nobody could ever satisfy.
 *
 * Found by driving next-smoke over MCP. Clicking Add task with
 * `equals: ["First task", "Task 2", "Task 3"]` returned `verified: "no"` in a response whose own
 * `evidence.value` was `["First task", "Task 2", "Task 3"]` and whose `stateDiffs` showed the array
 * arriving at exactly that. The failure text made the two look different rather than identical,
 * because the observed side is depth-capped for display and renders as `"[Array(3)]"` — so the agent
 * is shown `state 'items' is "[Array(3)]", expected ["First task","Task 2","Task 3"]` and has no way
 * to see that those are the same value.
 *
 * List state is the commonest thing there is to assert about, so this is a wide hole. `$contains` and
 * `$length` worked and were the accidental workaround.
 *
 * `matchValue` is shared with net `dataMatches`, so a JSON response body compared against a literal
 * object had the same hole.
 */

import { describe, expect, it } from 'vitest';
import { matchValue } from './predicate-eval.js';

describe('matchValue compares structure, not identity', () => {
  it('matches an array with equal contents', () => {
    expect(matchValue(['First task', 'Task 2', 'Task 3'], ['First task', 'Task 2', 'Task 3'])).toBe(
      true,
    );
  });

  it('still rejects an array whose contents differ', () => {
    expect(matchValue(['a', 'b'], ['a', 'c'])).toBe(false);
  });

  it('rejects on ORDER, because order is part of a list’s value', () => {
    expect(matchValue(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('rejects on length', () => {
    expect(matchValue(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    expect(matchValue(['a'], ['a', 'b'])).toBe(false);
  });

  it('matches a plain object with equal entries, whatever the key order', () => {
    expect(matchValue({ id: 1, name: 'x' }, { name: 'x', id: 1 })).toBe(true);
  });

  it('rejects an object with an extra key, in either direction', () => {
    // Equality, not a subset match. `dataMatches` is the field-by-field one; this is `equals`.
    expect(matchValue({ id: 1, name: 'x' }, { id: 1 })).toBe(false);
    expect(matchValue({ id: 1 }, { id: 1, name: 'x' })).toBe(false);
  });

  it('matches nested structure', () => {
    expect(matchValue({ items: [{ id: 1 }] }, { items: [{ id: 1 }] })).toBe(true);
    expect(matchValue({ items: [{ id: 1 }] }, { items: [{ id: 2 }] })).toBe(false);
  });

  it('does not treat an array as equal to an object', () => {
    expect(matchValue([], {})).toBe(false);
    expect(matchValue({}, [])).toBe(false);
  });

  it('leaves primitives and null exactly as they were', () => {
    expect(matchValue(1, 1)).toBe(true);
    expect(matchValue('a', 'a')).toBe(true);
    expect(matchValue(null, null)).toBe(true);
    expect(matchValue(null, {})).toBe(false);
    expect(matchValue(undefined, null)).toBe(false);
  });

  it('leaves the `*` wildcard alone', () => {
    expect(matchValue(['a'], '*')).toBe(true);
    expect(matchValue(undefined, '*')).toBe(false);
  });

  it('still routes an operator container to the operators, not to structural equality', () => {
    // `{ $length: 2 }` must stay an operator. Comparing it structurally would make it false against
    // every real value, which is the bug this fixes, pointed the other way.
    expect(matchValue(['a', 'b'], { $length: 2 })).toBe(true);
    expect(matchValue(['a', 'b'], { $contains: 'a' })).toBe(true);
    expect(matchValue(['a', 'b'], { $length: 3 })).toBe(false);
  });

  it('an empty object is still a literal, so it does not pass against anything', () => {
    // Pinned because it was a real false green: `{}` has no `$` key, entered the operator branch,
    // iterated nothing and returned true against undefined included.
    expect(matchValue(undefined, {})).toBe(false);
    expect(matchValue({ a: 1 }, {})).toBe(false);
    expect(matchValue({}, {})).toBe(true);
  });
});
