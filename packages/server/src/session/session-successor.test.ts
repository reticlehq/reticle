/**
 * A full-document navigation replaces the session. The agent still holds the old id.
 *
 * `act_and_wait` on a link ends `observation_lost` because the SDK died with the document;
 * `assert` then refuses the dead id even though the new page has already HELLO'd. Same-origin,
 * one live tab, the id the agent holds is the one that just left — that is a successor, not a
 * guess. Two live tabs at that origin is still a guess, and a never-seen id still is not.
 */

import { describe, expect, it } from 'vitest';
import { pickDocumentSuccessor, awaitDocumentSuccessor } from './session-successor.js';
import type { Session } from './session.js';
import type { SuccessorRegistry, SuccessorClock } from './session-successor.js';

const departed = {
  id: 'old',
  url: 'http://localhost:3000/orders',
  projectId: 'shop',
};

describe('pickDocumentSuccessor', () => {
  it('picks the one live session at the departed origin', () => {
    expect(
      pickDocumentSuccessor(
        [{ id: 'new', url: 'http://localhost:3000/orders/42', projectId: 'shop' }],
        departed,
      )?.id,
    ).toBe('new');
  });

  it('picks a same-id reconnect — the id survived, the document did not', () => {
    expect(
      pickDocumentSuccessor(
        [{ id: 'old', url: 'http://localhost:3000/orders/42', projectId: 'shop' }],
        departed,
      )?.id,
    ).toBe('old');
  });

  it('does not guess when two tabs share the origin', () => {
    expect(
      pickDocumentSuccessor(
        [
          { id: 'a', url: 'http://localhost:3000/a', projectId: 'shop' },
          { id: 'b', url: 'http://localhost:3000/b', projectId: 'shop' },
        ],
        departed,
      ),
    ).toBeUndefined();
  });

  it('does not pick a different origin', () => {
    expect(
      pickDocumentSuccessor(
        [{ id: 'other', url: 'http://localhost:9999/orders', projectId: 'shop' }],
        departed,
      ),
    ).toBeUndefined();
  });

  it('does not pick a different project on the same origin', () => {
    expect(
      pickDocumentSuccessor(
        [{ id: 'stray', url: 'http://localhost:3000/admin', projectId: 'admin' }],
        departed,
      ),
    ).toBeUndefined();
  });

  it('does not pick a different project even when the id matches', () => {
    // The guard above exists and is tested — but its test uses a DIFFERENT id, and the same-id
    // branch returned before the guard ran. Reachable exactly as reported: `sessionStorage` is
    // scoped to the ORIGIN, not the app, so recycling a port (stop app A on :3000, start app B,
    // reload the same tab) has app B read app A's id out of storage and register under it with its
    // own projectId. `resolve()` then answers an explicit sessionId with a different product.
    expect(
      pickDocumentSuccessor(
        [{ id: 'old', url: 'http://localhost:3000/admin', projectId: 'admin' }],
        departed,
      ),
    ).toBeUndefined();
  });

  it('refuses rather than falling through to another candidate when the id matches but is not eligible', () => {
    // Refusal, not a second guess. An exact id match that is ineligible is the strongest evidence
    // available that the caller's id is stale, and picking some other session on the origin would
    // be the silent redirect this whole function exists to prevent.
    expect(
      pickDocumentSuccessor(
        [
          { id: 'old', url: 'http://localhost:3000/admin', projectId: 'admin' },
          { id: 'fresh', url: 'http://localhost:3000/orders/42', projectId: 'shop' },
        ],
        departed,
      ),
    ).toBeUndefined();
  });

  it('still follows a same-id reload that dropped the session param from the url', () => {
    // `mayInherit` must NOT gate the same-id path, and this is the case that proves it. A driven or
    // leased tab carries `__reticle_session` in its URL, but `navigate { url, reload: true }`
    // reloads the BARE address, so the reconnecting document has no param. Demanding the claim
    // again refuses the ordinary reload this whole mechanism exists for — caught by the benchmark
    // gate, as a per-run cost rise, when an earlier version of this fix applied that gate here.
    //
    // The id is the identity on this path: it survived in sessionStorage, which a leased context
    // does not share with anybody's real browser tab. A human's tab could only carry the id by
    // carrying the param, which satisfies `mayInherit` anyway.
    expect(
      pickDocumentSuccessor(
        [{ id: 'lease-7', url: 'http://localhost:3000/orders', projectId: 'shop' }],
        {
          id: 'lease-7',
          url: 'http://localhost:3000/orders?__reticle_session=lease-7',
          projectId: 'shop',
        },
      )?.id,
    ).toBe('lease-7');
  });

  it('still refuses a DIFFERENT id that never made the claim', () => {
    // The guard `mayInherit` was actually written for is untouched: another session inheriting a
    // claimed identity is the case where an expired lease redirected the next call into somebody's
    // real browser tab.
    expect(
      pickDocumentSuccessor(
        [{ id: 'human-tab', url: 'http://localhost:3000/orders', projectId: 'shop' }],
        {
          id: 'lease-7',
          url: 'http://localhost:3000/orders?__reticle_session=lease-7',
          projectId: 'shop',
        },
      ),
    ).toBeUndefined();
  });

  it('with no projectId, origin alone is the match', () => {
    expect(
      pickDocumentSuccessor([{ id: 'new', url: 'http://localhost:3000/done' }], {
        id: 'old',
        url: 'http://localhost:3000/start',
      })?.id,
    ).toBe('new');
  });
});

function stub(id: string, url: string): Session {
  return { id, url } as Session;
}

function fakeClock(step: number): SuccessorClock {
  let t = 0;
  return {
    now: () => t,
    sleep: () => {
      t += step;
      return Promise.resolve();
    },
  };
}

describe('awaitDocumentSuccessor', () => {
  it('returns the session that arrives a few polls later', async () => {
    const departed = stub('old', 'http://localhost:3000/a');
    const next = stub('new', 'http://localhost:3000/b');
    const snapshots: Session[][] = [[], [], [next]];
    let look = 0;
    const sessions: SuccessorRegistry = {
      get: (id) => snapshots[Math.min(look, snapshots.length - 1)]?.find((s) => s.id === id),
      all: () => {
        const snap = snapshots[Math.min(look, snapshots.length - 1)] ?? [];
        look += 1;
        return snap;
      },
    };
    await expect(awaitDocumentSuccessor(sessions, departed, 5_000, fakeClock(25))).resolves.toBe(
      next,
    );
  });

  it('finds the successor even while the departed session is still listed', async () => {
    const departed = stub('old', 'http://localhost:3000/a');
    const next = stub('new', 'http://localhost:3000/b');
    const sessions: SuccessorRegistry = {
      get: (id) => (id === departed.id ? departed : id === next.id ? next : undefined),
      all: () => [departed, next],
    };
    await expect(awaitDocumentSuccessor(sessions, departed, 1_000, fakeClock(25))).resolves.toBe(
      next,
    );
  });

  it('gives up with null rather than hanging when nobody arrives', async () => {
    const departed = stub('old', 'http://localhost:3000/a');
    let looks = 0;
    const sessions: SuccessorRegistry = {
      get: () => undefined,
      all: () => {
        looks += 1;
        return [];
      },
    };
    await expect(
      awaitDocumentSuccessor(sessions, departed, 100, fakeClock(25)),
    ).resolves.toBeNull();
    expect(looks).toBeLessThanOrEqual(6);
  });
});
