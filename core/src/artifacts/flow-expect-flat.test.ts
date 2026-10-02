/**
 * A flow written before `expect` was a predicate still reads, and still means the same thing.
 *
 * This is the whole risk of the migration. Flows are committed to repositories that other people
 * share; a reader that changed what an existing file asserts would turn somebody's green red, or
 * worse, their red green, for a reason invisible in their diff.
 *
 * So: v1 lifts, v2 passes through, the two are told apart by `kind`, and a read never rewrites.
 */
import { describe, expect, it } from 'vitest';
import { FlowFileSchema } from './flow-types.js';
import { flowExpectToPredicate } from './flow-expect-flat.js';
import { PredicateKind } from '@/verdict/consequence.js';

const v1 = (step: Record<string, unknown>): Record<string, unknown> => ({
  version: 1,
  name: 'checkout',
  createdAt: 1,
  steps: [
    {
      tool: 'reticle_act',
      anchor: { kind: 'testid', value: 'submit' },
      args: {},
      ...step,
    },
  ],
});

const parsed = (file: Record<string, unknown>) => {
  const result = FlowFileSchema.safeParse(file);
  if (!result.success) throw new Error(result.error.issues.map((i) => i.message).join('; '));
  return result.data;
};

describe('reading a v1 flow', () => {
  it('lifts a flat signal expect into a signal predicate', () => {
    const flow = parsed(v1({ expect: { signal: 'order:placed' } }));
    expect(flow.steps[0]?.expect).toEqual({ kind: PredicateKind.SIGNAL, name: 'order:placed' });
  });

  it('lifts a flat element expect into an element predicate with a query', () => {
    const flow = parsed(v1({ expect: { element: { testid: 'receipt' } } }));
    expect(flow.steps[0]?.expect).toEqual({
      kind: PredicateKind.ELEMENT,
      query: { testid: 'receipt' },
    });
  });

  /*
   * The post-settle gate is part of what a v1 cardinality assertion MEANT, not decoration. An exact
   * count is transiently satisfied the instant the first matching request lands, before a
   * double-submit's duplicate arrives, so the lift has to carry the `settled` clause with it or the
   * flow that was recorded to catch a double submit stops catching one.
   */
  it('keeps the settle gate a v1 count assertion depended on', () => {
    const flow = parsed(v1({ expect: { net: { urlContains: '/api/order', count: 1 } } }));
    expect(flow.steps[0]?.expect).toEqual({
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.SETTLED },
        { kind: PredicateKind.NET, urlContains: '/api/order', count: 1 },
      ],
    });
  });

  it('leaves a v2 predicate exactly as written', () => {
    const written = {
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.SIGNAL, name: 'order:placed' },
        { kind: PredicateKind.NET, urlContains: '/api/order', status: 200 },
      ],
    };
    expect(parsed(v1({ expect: written })).steps[0]?.expect).toEqual(written);
  });

  /*
   * `kind` is the discriminator and no flat expect ever had one, so the two shapes cannot be
   * confused. A v1 expect that asserted nothing lifts to nothing rather than to a predicate nobody
   * wrote — an invented claim is worse than an absent one.
   */
  it('lifts an empty expect to nothing at all', () => {
    expect(parsed(v1({ expect: {} })).steps[0]?.expect).toBeUndefined();
  });

  it('lifts the success oracle and the precondition list the same way', () => {
    const flow = parsed({
      ...v1({}),
      success: { signal: 'checkout:done' },
      requires: [{ signal: 'auth:ready' }],
    });
    expect(flow.success).toEqual({ kind: PredicateKind.SIGNAL, name: 'checkout:done' });
    expect(flow.requires).toEqual([{ kind: PredicateKind.SIGNAL, name: 'auth:ready' }]);
  });

  // A hole in `requires` would make `canFollow` report a precondition as met by a claim that says
  // nothing at all, which is the composition check answering yes for the wrong reason.
  it('drops a precondition that asserts nothing rather than keeping a hole', () => {
    const flow = parsed({ ...v1({}), requires: [{}, { signal: 'auth:ready' }] });
    expect(flow.requires).toEqual([{ kind: PredicateKind.SIGNAL, name: 'auth:ready' }]);
  });

  // The read is a read. Whatever the file said is still what the file says.
  it('does not rewrite the version it read', () => {
    expect(parsed(v1({ expect: { signal: 'x' } })).version).toBe(1);
  });
});

/*
 * The v1 lift's SEMANTICS, which are not a shape question.
 *
 * These moved here with `flowExpectToPredicate` itself. Each one records why a v1 field compiles to
 * more than its obvious predicate: a cardinality or absence assertion is inherently POST-SETTLE, and
 * a wait-until-true evaluator satisfies it on the first transient match unless the lift says so.
 * Losing them in the migration would have quietly turned every double-submit guard back into a
 * predicate that passes on the first request.
 */
describe('flowExpectToPredicate — what a v1 field actually compiled to', () => {
  it('compiles a signal success', () => {
    expect(flowExpectToPredicate({ signal: 'order:placed' })).toEqual({
      kind: 'signal',
      name: 'order:placed',
    });
  });

  it('combines multiple fields with allOf', () => {
    const p = flowExpectToPredicate({ signal: 's', net: { urlContains: '/api' } });
    expect(p?.kind).toBe('allOf');
  });

  it('a net WITHOUT count stays a bare presence predicate (wait-until-true)', () => {
    expect(flowExpectToPredicate({ net: { urlContains: '/api/deploy' } })).toEqual({
      kind: 'net',
      urlContains: '/api/deploy',
    });
  });

  it('net.count gates on `settled` so a double-submit cannot pass on the first transient match', () => {
    // The cardinality read must happen AFTER the network quiets, else exact count:1 is satisfied the
    // instant the first request lands (before a duplicate). settled + net is the post-settle gate.
    expect(
      flowExpectToPredicate({ net: { method: 'POST', urlContains: '/api/deploy', count: 1 } }),
    ).toEqual({
      kind: 'allOf',
      predicates: [
        { kind: 'settled' },
        { kind: 'net', method: 'POST', urlContains: '/api/deploy', count: 1 },
      ],
    });
  });

  it('signalCount gates on `settled` so a double-fire cannot pass on the first transient match', () => {
    // Identical reasoning to net.count: a wait-until-true waiter sees exactly one fire the instant
    // the FIRST one lands, and resolves before the duplicate arrives. The count is only true after
    // the app goes quiet, so the settle gate is what makes the assertion mean what it says.
    expect(flowExpectToPredicate({ signal: 'order:placed', signalCount: 1 })).toEqual({
      kind: 'allOf',
      predicates: [{ kind: 'settled' }, { kind: 'signal', name: 'order:placed', count: 1 }],
    });
  });

  it('console.absent gates on `settled` (a clean-console assertion is post-settle)', () => {
    // Same post-settle reasoning as net.count: an absent assertion is satisfied at the first poll
    // (no error yet) before the action's error fires, so it must be read only after the page quiets.
    expect(flowExpectToPredicate({ console: { level: 'error', absent: true } })).toEqual({
      kind: 'allOf',
      predicates: [{ kind: 'settled' }, { kind: 'console', level: 'error', absent: true }],
    });
  });

  it('a console PRESENCE assertion (no absent) stays a bare wait-until-true predicate', () => {
    expect(flowExpectToPredicate({ console: { level: 'warn' } })).toEqual({
      kind: 'console',
      level: 'warn',
    });
  });

  it('a state INVARIANT (hold:true) gates on `settled` so a side-effect leak cannot pass early', () => {
    // Without the gate, "deployments.0.status == live" is true the instant replay starts (before a
    // blast-radius side-effect moves it), so a wait-until-true read passes. settled forces post-settle.
    expect(
      flowExpectToPredicate({
        state: { store: 'app', path: 'deployments.0.status', equals: 'live', hold: true },
      }),
    ).toEqual({
      kind: 'allOf',
      predicates: [
        { kind: 'settled' },
        { kind: 'state', store: 'app', path: 'deployments.0.status', equals: 'live' },
      ],
    });
  });

  it('compiles a state-truth success end-condition', () => {
    expect(
      flowExpectToPredicate({
        state: { store: 'app', path: 'deployments.0.status', equals: 'live' },
      }),
    ).toEqual({ kind: 'state', store: 'app', path: 'deployments.0.status', equals: 'live' });
  });

  it('compiles a presence-only state success (no equals → assert the path resolves)', () => {
    expect(flowExpectToPredicate({ state: { path: 'cart.items' } })).toEqual({
      kind: 'state',
      path: 'cart.items',
    });
  });
});

/*
 * A v1 `text.absent` gates on settle, for the same reason `console.absent` and `state.hold` do.
 *
 * A wait-until-true evaluator reads "not there yet" on the first poll and passes BEFORE the text it
 * was meant to watch disappear has even rendered. Moved here from the annotation tests when the
 * compiler it was asserting against became the v1 reader.
 */
describe('an absence assertion is post-settle', () => {
  it('gates a text absence on settle', () => {
    expect(flowExpectToPredicate({ text: { contains: 'Saving…', absent: true } })).toEqual({
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.SETTLED },
        { kind: PredicateKind.TEXT, contains: 'Saving…', absent: true },
      ],
    });
  });

  it('leaves a plain text presence as a bare wait-until-true predicate', () => {
    expect(flowExpectToPredicate({ text: { contains: '$17.99' } })).toEqual({
      kind: PredicateKind.TEXT,
      contains: '$17.99',
    });
  });
});
