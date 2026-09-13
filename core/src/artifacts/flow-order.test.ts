import { describe, expect, it } from 'vitest';
import { FLOW_FILE_VERSION, orderFlows, type FlowFile } from '../index.js';

/**
 * Some journeys only make sense after another one.
 *
 * "Checkout" assumes a signed-in user; run it first and it fails for a reason that has nothing to do
 * with checkout. Directory order is not an answer — it is alphabetical luck.
 *
 * The ordering is a fold, not a scheduler: it says what must come before what, and a cycle or a
 * missing prerequisite is REPORTED rather than resolved. Guessing an order for a contradictory
 * declaration would produce a suite that runs in an order nobody asked for and cannot be reasoned
 * about when it fails.
 */
const flow = (name: string, needs?: string[]): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name,
  createdAt: 0,
  steps: [],
  ...(needs === undefined ? {} : { needs }),
});

const names = (flows: readonly FlowFile[]): string[] => flows.map((f) => f.name);

describe('ordering a suite by what each flow needs', () => {
  it('leaves flows alone when nothing declares a prerequisite', () => {
    const ordered = orderFlows([flow('b'), flow('a')]);
    expect(names(ordered.run)).toEqual(['b', 'a']);
  });

  it('puts a prerequisite before the flow that needs it', () => {
    const ordered = orderFlows([flow('checkout', ['login']), flow('login')]);
    expect(names(ordered.run)).toEqual(['login', 'checkout']);
  });

  it('follows a chain', () => {
    const ordered = orderFlows([
      flow('refund', ['checkout']),
      flow('checkout', ['login']),
      flow('login'),
    ]);
    expect(names(ordered.run)).toEqual(['login', 'checkout', 'refund']);
  });

  it('keeps declaration order among flows that do not depend on each other', () => {
    // Stability matters: a suite whose order shuffles between runs makes a flaky flow impossible to
    // attribute, because "what ran before it" changed too.
    const ordered = orderFlows([flow('b'), flow('a'), flow('c', ['a'])]);
    expect(names(ordered.run)).toEqual(['b', 'a', 'c']);
  });

  it('reports a cycle instead of inventing an order for it', () => {
    const ordered = orderFlows([flow('a', ['b']), flow('b', ['a'])]);
    expect(ordered.cycles).toEqual(['a', 'b']);
    expect(names(ordered.run)).toEqual([]);
  });

  it('reports a prerequisite that is not in the run, and does not run the dependant', () => {
    // `login` was filtered out by a label, or quarantined, or never existed. Running `checkout`
    // anyway produces a failure about the wrong thing.
    const ordered = orderFlows([flow('checkout', ['login'])]);
    expect(ordered.unsatisfied).toEqual([{ flow: 'checkout', needs: 'login' }]);
    expect(names(ordered.run)).toEqual([]);
  });

  it('still runs the flows whose prerequisites ARE satisfied', () => {
    const ordered = orderFlows([flow('checkout', ['login']), flow('search')]);
    expect(names(ordered.run)).toEqual(['search']);
    expect(ordered.unsatisfied).toHaveLength(1);
  });
});
