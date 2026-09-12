import { describe, expect, it } from 'vitest';
import { fixtureIsUsable, type FixtureRef } from '@reticlehq/openreality';
import { WebRealm } from './web-realm.js';
import { createFakeSession } from '../session/fake-session.js';

/**
 * A realm must not OFFER a fixture it cannot honour.
 *
 * The specification is explicit: claiming a fixture you cannot restore produces flows that pass
 * because the previous flow happened to leave the right state behind — a suite that only works in
 * the order it was written. That is worse than running every flow from cold, which is merely slower.
 *
 * On the web the capability is not a property of the realm, it is a property of the CONNECTION. An
 * attached session — the common case, the user's own browser with the SDK in it — cannot write a
 * cookie jar from inside the page; httpOnly is the whole point of httpOnly. A DRIVEN page has a
 * browser context behind it and can. So the realm takes a port it may not have, and when it does not
 * have one the methods are ABSENT rather than present-and-throwing: `applyFixture === undefined` is
 * how an optional member says "not offered", and a method that exists and refuses reads as a
 * capability that is broken today.
 */

const EPOCH = 7;
const subjectOf = (realm: WebRealm): ReturnType<WebRealm['identity']> => realm.identity();

function ref(over: Partial<FixtureRef> = {}): FixtureRef {
  return {
    id: 'authed-operator',
    subject: { surface: 'web', instance: 'app', epoch: EPOCH },
    capturedAt: 0,
    ...over,
  };
}

describe('a web realm with no way to restore state', () => {
  it('does not offer the fixture methods at all', () => {
    const realm = new WebRealm({ session: createFakeSession(), now: () => 0 });
    expect(realm.applyFixture).toBeUndefined();
    expect(realm.captureFixture).toBeUndefined();
  });
});

describe('a web realm driving a page it can restore', () => {
  const port = () => {
    const applied: FixtureRef[] = [];
    return {
      applied,
      capture: () => Promise.resolve({ token: 'abc' }),
      apply: (payload: unknown) => {
        applied.push(payload as FixtureRef);
        return Promise.resolve();
      },
    };
  };

  it('offers them', () => {
    const realm = new WebRealm({ session: createFakeSession(), now: () => 0, fixtures: port() });
    expect(realm.applyFixture).toBeDefined();
    expect(realm.captureFixture).toBeDefined();
  });

  it('captures state stamped with the subject it came from', async () => {
    const realm = new WebRealm({ session: createFakeSession(), now: () => 0, fixtures: port() });
    const captured = await realm.captureFixture?.();
    expect(captured?.subject).toEqual(subjectOf(realm));
    // Vacuity: a capture that stamped nothing would satisfy an `undefined === undefined` check.
    expect(captured?.payload).toEqual({ token: 'abc' });
  });

  it('REFUSES to apply state captured from a build that has since been rewritten', async () => {
    // The reason the epoch travels at all. Restoring a session the current code would never have
    // issued makes every flow after it green against a state that cannot happen.
    const p = port();
    const realm = new WebRealm({ session: createFakeSession(), now: () => 0, fixtures: p });
    const stale = ref({ subject: { ...subjectOf(realm), epoch: EPOCH + 1 } });
    await expect(realm.applyFixture?.(stale)).rejects.toThrow(/epoch|rewritten|subject/i);
    expect(p.applied).toEqual([]);
  });

  it('applies one captured from this very subject', async () => {
    const p = port();
    const realm = new WebRealm({ session: createFakeSession(), now: () => 0, fixtures: p });
    const mine = ref({ subject: subjectOf(realm), payload: { token: 'abc' } });
    // Vacuity: if this subject were not usable the refusal above would pass for the wrong reason.
    expect(fixtureIsUsable(mine, subjectOf(realm))).toBe(true);
    await realm.applyFixture?.(mine);
    expect(p.applied).toEqual([{ token: 'abc' }]);
  });
});

/**
 * Being breakable is a capability a realm either has or does not, and saying so is the point.
 *
 * The mutation grade demotes a flow that survives a break. A realm that claimed it could break
 * things and quietly did not would demote flows for surviving a perturbation that never reached
 * them — a mutation score lying in the direction that looks like rigour, which is the worst
 * direction for a number whose whole purpose is to be sceptical of ourselves.
 */
describe('whether this realm can be broken on purpose', () => {
  it('does not offer mutation when nothing can perturb the page', () => {
    expect(new WebRealm({ session: createFakeSession(), now: () => 0 }).mutate).toBeUndefined();
  });

  it('offers it, and passes the mutation through, when something can', async () => {
    const asked: { kind: string; target?: string }[] = [];
    const realm = new WebRealm({
      session: createFakeSession(),
      now: () => 0,
      mutations: {
        mutate: (m) => {
          asked.push(m);
          return Promise.resolve({ mutation: 'request-fails:/api/orders' });
        },
        revert: () => Promise.resolve(),
      },
    });
    const reversal = await realm.mutate?.({ kind: 'request-fails', target: '/api/orders' });
    expect(asked).toEqual([{ kind: 'request-fails', target: '/api/orders' }]);
    // The undo travels back, because a break nobody can reverse is damage.
    expect(reversal?.mutation).toBe('request-fails:/api/orders');
  });
});
