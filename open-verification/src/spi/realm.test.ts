import { describe, expect, it } from 'vitest';
import { Realm } from './realm.js';
import { CHANNEL_DEFAULTS, ChannelId, Grade, Independence } from '@/vocabulary/channel.js';
import type { ChannelDescriptor } from '@/vocabulary/channel.js';
import { CloseCondition, RefusalReason } from '@/vocabulary/realm-surface.js';
import type { Action, ActionReceipt, Capability, Window } from '@/vocabulary/realm-surface.js';
import type { Coverage, Observation } from '@/vocabulary/evidence.js';
import { ResumeStrategy, resumeStrategy } from '@/vocabulary/determinism.js';
import type { SubjectRef } from '@/vocabulary/subject.js';

/**
 * That the base class actually holds the rules, rather than describing them.
 *
 * The point of an SPI over a document is that an implementer cannot forget. These tests are how we
 * know that is true — each one takes a deliberately careless implementation and checks that the
 * base class refuses on its behalf.
 */

/** A minimal realm, written the way a hurried implementer would write one. */
class Careless extends Realm {
  dispatched: Action[] = [];

  identity(): SubjectRef {
    return { surface: 'service', instance: 'svc-1', epoch: 2 };
  }
  determinism() {
    // A service: a POST is not idempotent, so its prefix must not be re-driven.
    return {
      reset: 'costly',
      replayPrefix: 'unsafe',
      time: 'wall',
      observation: 'exact',
      actions: 'irreversible',
    } as const;
  }
  channels(): readonly ChannelDescriptor[] {
    return [
      { id: ChannelId.NET, ...CHANNEL_DEFAULTS[ChannelId.NET] },
      { id: ChannelId.LOG, ...CHANNEL_DEFAULTS[ChannelId.LOG] },
    ];
  }
  capabilities(): readonly Capability[] {
    return [{ name: 'place_order', meaning: 'place an order', mutating: true }];
  }
  async describe(): Promise<unknown> {
    return {};
  }
  // Note what is missing: no capability check. That is the point.
  protected async dispatch(action: Action): Promise<ActionReceipt> {
    this.dispatched.push(action);
    return { action: action.id, dispatched: true, subject: this.identity(), at: action.at };
  }
  openWindow(budgetMs: number): Window {
    return {
      id: 'w1',
      openedAt: 0,
      budgetMs,
      closes: CloseCondition.ACK,
      subject: this.identity(),
    };
  }
  async observe(): Promise<readonly Observation[]> {
    return [];
  }
  async coverage(window: Window): Promise<Coverage> {
    return { window: window.id, observed: [ChannelId.NET, ChannelId.LOG], blindSpots: [] };
  }
}

const act = (capability: string): Action => ({
  id: 'a1',
  actor: 'test',
  capability,
  at: 1,
});

describe('the base class refuses what the implementation forgot to', () => {
  it('refuses an undeclared capability without the implementation being asked', () => {
    const realm = new Careless();
    return realm.perform(act('drop_database')).then((receipt) => {
      expect(receipt.dispatched).toBe(false);
      expect(receipt.refused?.reason).toBe(RefusalReason.UNDECLARED);
      // And crucially it never reached the implementation, which would have done it.
      expect(realm.dispatched).toHaveLength(0);
    });
  });

  it('names what IS declared, so the refusal is actionable rather than a wall', () => {
    return new Careless().perform(act('drop_database')).then((receipt) => {
      expect(receipt.refused?.detail).toContain('place_order');
    });
  });

  it('lets a declared capability through', async () => {
    const realm = new Careless();
    const receipt = await realm.perform(act('place_order'));
    expect(receipt.dispatched).toBe(true);
    expect(realm.dispatched).toHaveLength(1);
  });

  it('stamps every refusal with the subject, so late evidence can be checked for staleness', () => {
    return new Careless().perform(act('nope')).then((receipt) => {
      expect(receipt.subject.instance).toBe('svc-1');
      expect(receipt.subject.epoch).toBe(2);
    });
  });
});

describe('a realm knows what it cannot answer, before an action is spent', () => {
  it('names the channels a claim needs and it does not have', () => {
    const realm = new Careless();
    expect(realm.unobserved([ChannelId.NET, ChannelId.UI, ChannelId.STATE])).toEqual([
      ChannelId.UI,
      ChannelId.STATE,
    ]);
  });

  it('reports honestly that it can prove things, having an independent channel', () => {
    expect(new Careless().canProveAnything()).toBe(true);
  });

  /**
   * An independent channel is NECESSARY and not sufficient, and this method said otherwise.
   *
   * Its own documentation is unambiguous: an implementation for which this is false "can describe,
   * act and report presence. It can NEVER PROVE ANYTHING." But the predicate tested independence
   * alone, so a realm whose every independent channel is presence-grade was told it could prove
   * things -- and then met clause 9, which asks for independent AND consequence-grade evidence,
   * and never got past it. Two questions, near-identical names, and the realm's one answered the
   * wrong one.
   *
   * Found by a realm that is exactly this shape: a command-line tool observing only its output,
   * its exit code and the kill the operating system imposed. That last one is genuinely
   * independent -- the kernel decided it -- and it is presence-grade, because knowing a process
   * was killed is not knowing what it did.
   */
  it('refuses to claim it can prove anything when every independent channel is presence-grade', () => {
    class PresenceOnly extends Careless {
      override channels(): readonly ChannelDescriptor[] {
        return [
          // Independent, and worth nothing towards a proof: another party decided it, and what it
          // tells you is that something ENDED, not what it did.
          { id: 'x-proc', independence: Independence.INDEPENDENT, grade: Grade.PRESENCE },
          { id: ChannelId.LOG, ...CHANNEL_DEFAULTS[ChannelId.LOG] },
        ];
      }
    }
    expect(new PresenceOnly().canProveAnything()).toBe(false);
  });
});

describe('there is no way for a realm to return a verdict', () => {
  it('exposes no method that produces one', () => {
    // The structural guarantee. A realm that could decide whether its own action succeeded would
    // be the thing under test grading its own work, and every honest property of this protocol
    // descends from the fact that it cannot.
    const surface = new Set([
      ...Object.getOwnPropertyNames(Realm.prototype),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(new Careless())),
    ]);
    for (const forbidden of ['verify', 'verdict', 'adjudicate', 'assert', 'pass', 'succeeded']) {
      expect(surface.has(forbidden), `Realm must not expose ${forbidden}()`).toBe(false);
    }
  });
});

/**
 * A realm must DECLARE how it may be driven, and the refusal is derived from that declaration.
 *
 * Abstract rather than defaulted is the whole point, and the COMPILER is the test: a realm that
 * omits it does not build. A default of `free` would be the protocol telling a payment service it is
 * a browser; a default of `unsafe` would silently downgrade every realm that is honestly cheap to
 * re-drive. `channels()` is abstract for the same reason, and this is the more expensive of the two
 * to get wrong — a channel you cannot observe costs a wrong verdict, a `replayPrefix` you do not
 * have costs a re-sent payment.
 */
describe('how a realm says it may be driven', () => {
  it('is read through the derived strategy, never as a raw field', () => {
    const realm = new Careless();
    expect(resumeStrategy(realm.determinism())).toBe(ResumeStrategy.REFUSE);
  });
});
