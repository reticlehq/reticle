import { describe, expect, it } from 'vitest';
import { PredicateSchema, predicateAliasesUsed } from '../index.js';

/**
 * Three forms agents send for a predicate, read as the one predicate each can mean.
 *
 * Each one was a `bad_args` refusal: no verdict, and one more call. Each is read only where one
 * reading exists. Each read is named in `predicateAliasesUsed`, so the agent sees what was checked.
 *
 * - A bare string (`until: "Saved"`). It becomes text that must be VISIBLE, so a page without the
 *   text fails the check.
 * - `{ text: { contains } }`: reported in #1001. `reticle_tools` keys its grammar by kind, and agents
 *   read that key as a wrapper.
 * - `{ kind: "absent", ... }`: reported in #1001 and in agent feedback. `absent` is a field of
 *   `element`, `text` and `console`, and the grammar lists it beside the kinds.
 */
describe('a bare string predicate', () => {
  it('is visible text, which can fail', () => {
    expect(PredicateSchema.parse('Saved')).toEqual({
      kind: 'text',
      contains: 'Saved',
      visible: true,
    });
  });

  it('is read the same way inside a combinator', () => {
    expect(PredicateSchema.parse({ kind: 'allOf', predicates: ['Saved', 'Done'] })).toEqual({
      kind: 'allOf',
      predicates: [
        { kind: 'text', contains: 'Saved', visible: true },
        { kind: 'text', contains: 'Done', visible: true },
      ],
    });
  });

  it('is named in the report', () => {
    expect(predicateAliasesUsed('Saved')).toEqual([
      '"Saved" → { kind: "text", contains: "Saved", visible: true }',
    ]);
  });

  it('is refused when it is empty, because empty text is on every page', () => {
    for (const blank of ['', '   ']) {
      const got = PredicateSchema.safeParse(blank);
      expect(got.success, JSON.stringify(blank)).toBe(false);
    }
  });

  it('is refused when it can also mean a route, a selector or a signal, and names both readings', () => {
    const cases: [string, RegExp][] = [
      ['/dashboard', /kind: "route", pathname: "\/dashboard"/],
      ['https://x.test/done', /kind: "route"/],
      ['#total', /kind: "element", query: \{ scope: "#total", self: true \}/],
      ['.toast', /scope: "\.toast"/],
      ['todos:loaded', /kind: "signal", name: "todos:loaded"/],
    ];
    for (const [written, other] of cases) {
      const got = PredicateSchema.safeParse(written);
      expect(got.success, written).toBe(false);
      const said = got.success ? '' : got.error.issues.map((issue) => issue.message).join('\n');
      expect(said, written).toMatch(other);
      expect(said, written).toContain(`{ kind: "text", contains: ${JSON.stringify(written)} }`);
    }
  });

  it('is refused when it reads as a description of the outcome, not as text on the page', () => {
    // `act-sequence-steps.test.ts` pins `expect: "the receipt appears"`. Read as text, it fails on
    // every page and blames the app for a check nobody meant.
    for (const written of ['the receipt appears', 'Order should be saved', 'a toast is shown']) {
      const got = PredicateSchema.safeParse(written);
      expect(got.success, written).toBe(false);
      const said = got.success ? '' : got.error.issues.map((issue) => issue.message).join('\n');
      expect(said, written).toContain('the exact text the page shows');
    }
  });

  it('keeps short page text, such as "Order placed" and "Welcome back, Priya"', () => {
    for (const written of ['Order placed', 'Welcome back, Priya', 'Saved!']) {
      expect(PredicateSchema.parse(written), written).toMatchObject({ contains: written });
    }
  });

  it('keeps text that only has a colon and spaces, such as "Total: 5"', () => {
    expect(PredicateSchema.parse('Total: 5')).toMatchObject({ kind: 'text', contains: 'Total: 5' });
  });
});

describe('a text predicate written inside a `text` key', () => {
  it('is that text predicate', () => {
    expect(PredicateSchema.parse({ text: { contains: 'Saved' } })).toEqual({
      kind: 'text',
      contains: 'Saved',
    });
    expect(PredicateSchema.parse({ text: { contains: 'Saved', scope: '#d' } })).toEqual({
      kind: 'text',
      contains: 'Saved',
      scope: '#d',
    });
  });

  it('is named in the report', () => {
    expect(predicateAliasesUsed({ text: { contains: 'Saved' } })).toEqual([
      '{ text: { ... } } → { kind: "text", ... }',
    ]);
  });

  it('is not read for another kind, a second key, or a field that format does not take', () => {
    for (const written of [
      { route: { path: '/done' } },
      { net: { urlContains: '/api', count: 1 } },
      { text: { contains: 'a' }, scope: '#x' },
      { text: { kind: 'net', urlContains: '/a' } },
      { text: { contains: 'a', label: 'b' } },
      // A version 1 flow reads this with a settle gate, and the predicate reads it without one.
      { text: { contains: 'Error', absent: true } },
    ]) {
      expect(PredicateSchema.safeParse(written).success, JSON.stringify(written)).toBe(false);
    }
  });

  it('leaves `not` as it was', () => {
    expect(PredicateSchema.parse({ not: { kind: 'text', contains: 'Error' } })).toEqual({
      kind: 'not',
      predicate: { kind: 'text', contains: 'Error' },
    });
  });
});

describe('`absent` written as the kind', () => {
  it('is the absence of the one kind the other keys name', () => {
    expect(PredicateSchema.parse({ kind: 'absent', text: 'Error' })).toEqual({
      kind: 'text',
      contains: 'Error',
      absent: true,
    });
    expect(PredicateSchema.parse({ kind: 'absent', testid: 'spinner' })).toEqual({
      kind: 'element',
      query: { testid: 'spinner' },
      absent: true,
    });
    expect(PredicateSchema.parse({ type: 'absent', level: 'error' })).toEqual({
      kind: 'console',
      level: 'error',
      absent: true,
    });
  });

  it('is named in the report', () => {
    expect(predicateAliasesUsed({ kind: 'absent', text: 'Error' })).toEqual([
      'kind: "absent" → kind: "text", absent: true',
      'text.text → contains',
    ]);
  });

  it('is refused when the keys fit two kinds, fit none, or already say `absent: false`', () => {
    for (const written of [
      { kind: 'absent' },
      { kind: 'absent', name: 'x' },
      { kind: 'absent', text: 'Error', absent: false },
      { kind: 'absent', pathname: '/x' },
    ]) {
      expect(PredicateSchema.safeParse(written).success, JSON.stringify(written)).toBe(false);
    }
  });
});
