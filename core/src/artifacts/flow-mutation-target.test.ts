import { describe, expect, it } from 'vitest';
import { mutationTargetsFor } from '../index.js';
import type { FlowFile } from '../index.js';

/**
 * What to break, chosen from what the flow itself claims to depend on.
 *
 * This is the decision that makes a mutation score mean anything, and the one place it can quietly
 * stop meaning anything. Break an endpoint the flow never touches and the flow survives — which
 * reads as "this test is worthless" and is really "we broke the wrong thing". A mutation set that
 * aims badly reports a suite full of bad tests and is itself the bug.
 *
 * A flow that declares a network consequence has already said what it depends on, in its own words,
 * at record time. That declaration is the target: break exactly what the flow claims to need, and a
 * flow that still passes has genuinely proved nothing about it.
 *
 * A flow that declares no network consequence yields NO target, and that is a finding rather than a
 * gap to paper over. There is nothing to break that this flow has claimed to care about, so guessing
 * one would manufacture the demotion rather than measure it.
 */

const flow = (over: Partial<FlowFile>): FlowFile => ({
  version: 1,
  name: 'checkout',
  createdAt: 0,
  steps: [],
  ...over,
});

describe('what a flow says it depends on', () => {
  it('takes the endpoint a step declared', () => {
    const f = flow({
      steps: [{ tool: 'act', args: {}, expect: { net: { urlContains: '/api/orders' } } }],
    } as Partial<FlowFile>);
    expect(mutationTargetsFor(f)).toEqual(['/api/orders']);
  });

  it('takes the endpoint the flow’s success consequence declared', () => {
    expect(mutationTargetsFor(flow({ success: { net: { urlContains: '/api/pay' } } }))).toEqual([
      '/api/pay',
    ]);
  });

  it('walks sub-steps, because a sequence is where the real journeys live', () => {
    const f = flow({
      steps: [
        {
          tool: 'act_sequence',
          args: {},
          steps: [{ tool: 'act', args: {}, expect: { net: { urlContains: '/api/cart' } } }],
        },
      ],
    } as Partial<FlowFile>);
    expect(mutationTargetsFor(f)).toEqual(['/api/cart']);
  });

  it('names each endpoint once, however many steps depend on it', () => {
    const f = flow({
      steps: [
        { tool: 'act', args: {}, expect: { net: { urlContains: '/api/orders' } } },
        { tool: 'act', args: {}, expect: { net: { urlContains: '/api/orders' } } },
      ],
    } as Partial<FlowFile>);
    expect(mutationTargetsFor(f)).toEqual(['/api/orders']);
  });

  it('is EMPTY when the flow declares no network consequence at all', () => {
    // Not a failure of this function. A flow that never said it depended on a request has given
    // nothing to break, and inventing a target would manufacture the demotion rather than measure it.
    const f = flow({
      steps: [{ tool: 'act', args: {}, expect: { signal: 'order:placed' } }],
    } as Partial<FlowFile>);
    expect(mutationTargetsFor(f)).toEqual([]);
  });

  it('ignores a net consequence with no url to aim at', () => {
    // `{ net: { status: 200 } }` says "some request succeeded" and names nothing breakable.
    const f = flow({
      steps: [{ tool: 'act', args: {}, expect: { net: { status: 200 } } }],
    } as Partial<FlowFile>);
    expect(mutationTargetsFor(f)).toEqual([]);
  });
});
