import { describe, expect, it } from 'vitest';
import {
  ContradictionKind,
  ReplayStatus,
  type FlowFile,
  type FlowReplayResult,
} from '@reticlehq/core';
import { buildSuiteVerdict } from './decision.js';

/**
 * The suite has to carry contradictions off PASSING flows, or it cannot see the thing it is for.
 *
 * Each step already detects them, and a step reports them regardless of `ok` — that rule was written
 * precisely because a green step with a failed request in its window is the false green this product
 * exists to catch. But a suite verdict returns `failures` only. Every contradiction on a flow that
 * passed was computed, attached, and then thrown away at the exact moment a reader would have seen
 * it: a hundred-step nightly run reporting "all 12 flows pass".
 */

function flow(name: string): FlowFile {
  return { name, steps: [{ tool: 'click', args: {} }] } as unknown as FlowFile;
}

const swallowed = {
  kind: ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
  claim: 'the screen advanced',
  counter: 'POST /api/orders returned 500',
  detail: 'POST /api/orders 500',
};

function greenWithContradiction(name: string): FlowReplayResult {
  return {
    name,
    status: ReplayStatus.OK,
    steps: [{ step: 0, ok: true, contradictions: [swallowed] }],
  } as FlowReplayResult;
}

describe('contradictions survive a green suite', () => {
  it('reports one found on a flow that passed', () => {
    const verdict = buildSuiteVerdict([
      { replay: greenWithContradiction('checkout'), flow: flow('checkout') },
    ]);
    expect(verdict.contradictions).toEqual([{ flow: 'checkout', step: 0, ...swallowed }]);
  });

  it('refuses to call the suite a pass while a channel disagrees', () => {
    // `pass` here would be the false green in the feature sold as the regression suite. It is not a
    // `fail` either — nothing the flow declared went unproved — so it lands where the other
    // "green that cannot be trusted" already lives.
    const verdict = buildSuiteVerdict([
      { replay: greenWithContradiction('checkout'), flow: flow('checkout') },
    ]);
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.summary).toContain('contradict');
  });

  it('collects them from failing flows too, where the step detail is otherwise lost', () => {
    const failing = {
      name: 'billing',
      status: ReplayStatus.ERROR,
      steps: [{ step: 2, ok: false, contradictions: [swallowed] }],
    } as FlowReplayResult;
    const verdict = buildSuiteVerdict([{ replay: failing, flow: flow('billing') }]);
    expect(verdict.contradictions).toHaveLength(1);
    expect(verdict.contradictions?.[0]?.step).toBe(2);
  });

  it('omits the field entirely when the channels agreed', () => {
    const clean = {
      name: 'login',
      status: ReplayStatus.OK,
      steps: [{ step: 0, ok: true }],
    } as FlowReplayResult;
    const verdict = buildSuiteVerdict([{ replay: clean, flow: flow('login') }]);
    expect(verdict.contradictions).toBeUndefined();
    expect(verdict.status).toBe('unverifiable'); // the fixture flow asserts nothing; unrelated
  });
});
