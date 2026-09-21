/**
 * A predicate the caller wrote badly must not cost them the action AND the verdict.
 *
 * `reticle_act_and_wait` dispatches, then evaluates `until` — so a locator naming fields the element
 * resolver drops used to be caught only after the click had landed, and reported as
 * `verified:"unknown", inconclusive`: "Reticle could not tell what happened". Reticle could tell.
 * What it could not do was evaluate the predicate, and blaming the app for that sends somebody to
 * fix code that is not broken.
 */
import { describe, expect, it } from 'vitest';
import { unevaluablePredicateReason, vacuousPredicateReason } from './predicate-precheck.js';

const el = (query: Record<string, unknown>) => ({ kind: 'element', query });

describe('refusing what could never be evaluated', () => {
  it('catches the locator that started this — `by` alongside `label`', () => {
    const reason = unevaluablePredicateReason(el({ by: 'label', label: 'Workspace name' }));
    expect(reason).toContain('ignores');
    expect(reason).toContain('Nothing was acted on');
  });

  it('names the offending field, so the fix is obvious', () => {
    // `placeholder` is dropped by the resolver and there is no descriptor to check it against
    // afterwards, which is what makes it unusable rather than a residual check.
    expect(unevaluablePredicateReason(el({ testid: 'submit', placeholder: 'Email' }))).toContain(
      'placeholder',
    );
  });

  it('allows a field the resolver drops but this side CAN still check', () => {
    // role/name/value/text are recoverable from the element descriptor, so they narrow the match
    // after the fact rather than making the predicate unevaluable. Refusing those would reject
    // predicates that work.
    expect(
      unevaluablePredicateReason(el({ by: 'testid', value: 'x', role: 'button' })),
    ).toBeUndefined();
  });

  it('allows a locator the resolver can actually use', () => {
    expect(unevaluablePredicateReason(el({ testid: 'submit' }))).toBeUndefined();
    expect(unevaluablePredicateReason(el({ role: 'button', name: 'Sign In' }))).toBeUndefined();
    expect(unevaluablePredicateReason(el({ by: 'testid', value: 'submit' }))).toBeUndefined();
  });

  it('leaves predicates with no locator alone', () => {
    for (const p of [
      { kind: 'net', urlContains: '/v1/x', status: 200 },
      { kind: 'text', contains: 'hello' },
      { kind: 'signal', name: 'saved' },
      { kind: 'settled' },
    ]) {
      expect(unevaluablePredicateReason(p), JSON.stringify(p)).toBeUndefined();
    }
  });

  it('finds an unusable locator nested inside allOf', () => {
    // The composite case is the one that matters: a good predicate beside a bad one still cannot be
    // evaluated, and the good half passing would be the most misleading outcome of all.
    const reason = unevaluablePredicateReason({
      kind: 'allOf',
      predicates: [
        { kind: 'net', urlContains: '/x', status: 200 },
        el({ by: 'label', label: 'W' }),
      ],
    });
    expect(reason).toContain('ignores');
  });

  it('finds one nested two levels deep', () => {
    const reason = unevaluablePredicateReason({
      kind: 'allOf',
      predicates: [{ kind: 'anyOf', predicates: [el({ by: 'label', label: 'W' })] }],
    });
    expect(reason).toContain('ignores');
  });

  it('finds one behind a `not`', () => {
    expect(
      unevaluablePredicateReason({ kind: 'not', predicate: el({ by: 'label', label: 'W' }) }),
    ).toContain('ignores');
  });

  it('passes a composite whose locators are all usable', () => {
    expect(
      unevaluablePredicateReason({
        kind: 'allOf',
        predicates: [el({ testid: 'a' }), { kind: 'net', urlContains: '/x' }],
      }),
    ).toBeUndefined();
  });

  it('tolerates junk rather than throwing on the hot path', () => {
    for (const junk of [undefined, null, 'string', 42, [], {}]) {
      expect(() => unevaluablePredicateReason(junk)).not.toThrow();
    }
  });
});

/**
 * A predicate that is true the moment it is written is not a check.
 *
 * `{ kind: 'route' }` with no pathname, and `{ kind: 'state', path: '' }` with nothing to compare,
 * are unconditionally true: there is always a current route and there is always some store. Declared
 * as an `until` they came back `no-fault` / `already_true` — a verdict-shaped object carrying no
 * proof, which an agent skimming for `ok` reads as a pass. Refusing costs the caller nothing they
 * had; answering costs them the action and the verdict.
 */
describe('refusing what was already true before the action', () => {
  it('refuses a bare route — there is always a current route', () => {
    const reason = vacuousPredicateReason({ kind: 'route' });
    expect(reason).toContain('route');
    expect(reason).toContain('Nothing was acted on');
  });

  it('refuses a state predicate with an empty path and nothing to compare', () => {
    expect(vacuousPredicateReason({ kind: 'state', path: '' })).toContain('state');
    expect(vacuousPredicateReason({ kind: 'state', path: '   ' })).toContain('state');
  });

  it('names what to declare instead, and the tool that supplies the vocabulary', () => {
    // A refusal without a route is a dead end, and the two kinds that CAN be declared bare are the
    // whole answer for a caller who does not yet know the app.
    const reason = vacuousPredicateReason({ kind: 'route' }) ?? '';
    expect(reason).toContain('signal');
    expect(reason).toContain('net');
    expect(reason).toContain('reticle_observe');
  });

  it('allows a route that names a pathname or a substring', () => {
    expect(vacuousPredicateReason({ kind: 'route', pathname: '/checkout' })).toBeUndefined();
    expect(vacuousPredicateReason({ kind: 'route', contains: 'checkout' })).toBeUndefined();
  });

  it('allows a state predicate that names a path, or compares the whole store', () => {
    expect(vacuousPredicateReason({ kind: 'state', path: 'cart.total' })).toBeUndefined();
    expect(
      vacuousPredicateReason({ kind: 'state', path: '', equals: { items: 1 } }),
    ).toBeUndefined();
    expect(
      vacuousPredicateReason({ kind: 'state', path: '', satisfies: { length: { gt: 0 } } }),
    ).toBeUndefined();
  });

  it('leaves the kinds that CAN be declared bare alone', () => {
    // `signal` and `net` read the event stream from the act's own cursor, so a bare one cannot be
    // answered by the past. `settled` is the documented omit-`until` default and is not a claim.
    for (const p of [{ kind: 'signal' }, { kind: 'net' }, { kind: 'settled' }]) {
      expect(vacuousPredicateReason(p), JSON.stringify(p)).toBeUndefined();
    }
  });

  it('finds a bare one nested inside a composite', () => {
    // `anyOf` is the expensive case: one unconditionally-true branch makes the whole thing true, so
    // the good branch beside it never has to hold.
    expect(
      vacuousPredicateReason({
        kind: 'anyOf',
        predicates: [{ kind: 'signal', name: 'saved' }, { kind: 'route' }],
      }),
    ).toContain('route');
    expect(
      vacuousPredicateReason({ kind: 'not', predicate: { kind: 'state', path: '' } }),
    ).toContain('state');
  });

  it('tolerates junk rather than throwing on the hot path', () => {
    for (const junk of [undefined, null, 'string', 42, [], {}]) {
      expect(() => vacuousPredicateReason(junk)).not.toThrow();
    }
  });
});
