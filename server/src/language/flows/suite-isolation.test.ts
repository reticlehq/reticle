import { describe, expect, it } from 'vitest';
import { ReplayStatus, SuiteIsolation } from '@reticlehq/core';
import { buildSuiteVerdict } from './decision.js';

/**
 * Two isolation modes, two different numbers, reported as if they were the same measurement.
 *
 * MEASURED on the bench app, same daemon, same flows, same untouched source: the sequential suite
 * answered 13/34 and `parallel: 4` answered 11/34. Each was reproducible, so whichever a reader ran
 * looked authoritative.
 *
 * Parallel is the honest one. Sequential replays every flow in ONE live session, so state
 * accumulates: `suite-404`, `suite-500`, `suite-route` and `suite-shape` all start at `/`, click a
 * nav item that exists only behind authentication, and never sign in. They pass sequentially only
 * because an earlier flow left the session signed in — they would pass with sign-in completely
 * broken. Parallel leases each flow its own context and they fail, correctly.
 *
 * Resetting between sequential flows is NOT the fix and was already tried: `storageState` carries
 * cookies and localStorage but not sessionStorage, so it restored part of an auth session and the
 * suite went from noisy to failing. That revert is recorded in flow-tools.ts.
 *
 * So the verdict says which mode produced it. A number that cannot be compared with the number
 * beside it has to say so, or the two get read as a regression that never happened.
 */
const green = (name: string) => ({
  replay: { name, status: ReplayStatus.OK, steps: [{ step: 0, anchor: 'a', ok: true }] },
  flow: {
    version: 1,
    name,
    steps: [
      {
        tool: 'reticle_act',
        anchor: { kind: 'testid', value: 'a' },
        expect: { element: { testid: 'b' } },
      },
    ],
  },
});

describe('a suite verdict says how it was isolated', () => {
  it('marks a sequential run as sharing one session', () => {
    const v = buildSuiteVerdict([green('one')] as never, [], SuiteIsolation.SHARED_SESSION);
    expect(v.isolation).toBe(SuiteIsolation.SHARED_SESSION);
  });

  it('warns in the summary that a shared-session pass can depend on run order', () => {
    const v = buildSuiteVerdict(
      [green('one'), green('two')] as never,
      [],
      SuiteIsolation.SHARED_SESSION,
    );
    expect(v.summary).toMatch(/order|shared|earlier flow/i);
  });

  it('does not warn about sharing when there is only one flow to share with', () => {
    // Nothing ran before it in this suite, so no pass here can be inherited from a sibling.
    const v = buildSuiteVerdict([green('one')] as never, [], SuiteIsolation.SHARED_SESSION);
    expect(v.isolation).toBe(SuiteIsolation.SHARED_SESSION);
    expect(v.summary).not.toMatch(/earlier flow/i);
  });

  it('marks a leased run as isolated, and does not warn', () => {
    const v = buildSuiteVerdict([green('one')] as never, [], SuiteIsolation.PER_FLOW_LEASE);
    expect(v.isolation).toBe(SuiteIsolation.PER_FLOW_LEASE);
    expect(v.summary).not.toMatch(/depend on the order/i);
  });

  it('omits the field entirely when the caller did not say, so nothing is invented', () => {
    expect(buildSuiteVerdict([green('one')] as never).isolation).toBeUndefined();
  });
});
