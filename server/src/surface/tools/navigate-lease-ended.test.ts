/**
 * Reported by agents on 3.10.7 (#2482): the lease ended while `reticle_navigate` waited for the
 * leased page's SDK. Navigate waited out the whole window and then said the page has no SDK and the
 * lease was kept. The screenshot error in the same answer said the lease had ended.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';

const LEASE_ID = 'lease-1';
const LEASE_URL = `http://localhost:4391/?__reticle_session=${LEASE_ID}`;
const WINDOW_MS = 60_000;
const CLOCK_STEP_MS = 1_000;

/** A lease whose page has no SDK, and that ends once the browser has navigated it. */
function endingLease(): { deps: ToolDeps; clockReads: () => number } {
  let leased = true;
  let reads = 0;
  const deps = {
    now: () => {
      reads += 1;
      return reads * CLOCK_STEP_MS;
    },
    sessions: {
      resolve: (id?: string) => {
        throw new Error(`no connected session with id '${String(id)}'`);
      },
      get: () => undefined,
      all: () => [],
      count: () => 0,
    },
    pool: {
      leasedSessionIds: () => (leased ? [LEASE_ID] : []),
      leaseUrl: () => (leased ? LEASE_URL : undefined),
      gotoLease: () => {
        // The reaper or a release takes the lease while the page loads.
        leased = false;
        return Promise.resolve(true);
      },
      touch: () => undefined,
    },
  } as unknown as ToolDeps;
  return { deps, clockReads: () => reads };
}

describe('navigating a lease that ends during the wait for its SDK', () => {
  it('stops waiting and says the lease ended, not that it was kept', async () => {
    const { deps, clockReads } = endingLease();
    const navigate = TOOLS.find((t) => ReticleTool.NAVIGATE === t.name);
    const answer = (await navigate?.handler(deps, {
      sessionId: LEASE_ID,
      url: 'http://localhost:4391/settings',
      timeout_ms: WINDOW_MS,
    })) as Record<string, unknown>;

    expect(answer['ok']).toBe(false);
    expect(String(answer['reason'])).toContain(`Lease '${LEASE_ID}' has ended`);
    expect(String(answer['reason'])).toContain('reticle_lease');
    expect(answer['note']).toBeUndefined();
    // It did not wait out the window: a full wait reads the clock once per poll until 60 s pass.
    expect(clockReads()).toBeLessThan(WINDOW_MS / CLOCK_STEP_MS);
  });
});
