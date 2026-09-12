import { describe, expect, it } from 'vitest';
import { Witness, witnessDisagreement } from './witness.js';
import { adjudicate } from './adjudicator.js';
import {
  CHANNEL_DEFAULTS,
  ChannelId,
  Grade,
  Independence,
  type ChannelDescriptor,
} from '../vocabulary/channel.js';
import { AnomalyKind, AnomalyTier, Verdict } from '../vocabulary/verdict.js';
import { CloseCondition, type Window } from '../vocabulary/realm-surface.js';
import { BlindSpotKind, type Coverage, type Observation } from '../vocabulary/evidence.js';
import { Surface, type SubjectRef } from '../vocabulary/subject.js';

/**
 * A second vantage point that can look and cannot touch.
 *
 * Every channel a realm declares is, in the end, the subject describing itself. The DOM says the
 * order was saved because the app wrote that on the screen; the network says so because the app made
 * the call. When an app lies to itself — the optimistic update that was never committed — every
 * channel inside it repeats the lie consistently, and no amount of evidence from in there settles
 * it. The database is not in there.
 *
 * A `Witness` is therefore a `Realm` minus the ability to act, and the omission is the point: it
 * cannot be the thing that caused what it reports. Modelling it as a realm with the action methods
 * left unimplemented would be the interface inviting exactly the coupling that makes its evidence
 * worthless.
 */

/** A database vantage point: it can read rows and it cannot click anything. */
class DatabaseWitness extends Witness {
  constructor(private readonly rows: readonly Observation[]) {
    super();
  }
  identity(): SubjectRef {
    return { surface: Surface.SERVICE, instance: 'orders-db', epoch: 1 };
  }
  channels(): readonly ChannelDescriptor[] {
    return [
      {
        ...CHANNEL_DEFAULTS,
        id: ChannelId.STATE,
        // The whole reason it is worth asking: it did not cause what it reports.
        independence: Independence.INDEPENDENT,
        grade: Grade.CONSEQUENCE,
      },
    ];
  }
  openWindow(budgetMs: number): Window {
    return {
      id: 'w1',
      openedAt: 0,
      budgetMs,
      closes: CloseCondition.BUDGET_EXHAUSTED,
      subject: this.identity(),
    };
  }
  observe(): Promise<readonly Observation[]> {
    return Promise.resolve(this.rows);
  }
  coverage(): Promise<Coverage> {
    return Promise.resolve({ window: 'w1', observed: [ChannelId.STATE], blindSpots: [] });
  }
}

const CLAIM = 'the order was saved';

function actorSaid(): Parameters<typeof witnessDisagreement>[0] {
  return { claim: CLAIM, channel: ChannelId.UI };
}

describe('a witness that cannot act', () => {
  it('has no way to dispatch, locate or describe — only to look', () => {
    const witness: unknown = new DatabaseWitness([]);
    for (const method of ['perform', 'dispatch', 'locate', 'capabilities']) {
      expect(witness, method).not.toHaveProperty(method);
    }
  });
});

describe('what the witness saw, against what the subject claimed', () => {
  it('contradicts a claim nothing outside the subject corroborates', () => {
    const anomaly = witnessDisagreement(actorSaid(), { channel: ChannelId.STATE, observed: [] });
    expect(anomaly?.kind).toBe(AnomalyKind.CLAIM_UNCORROBORATED);
    expect(anomaly?.tier).toBe(AnomalyTier.OBSERVED);
    expect(anomaly?.between).toEqual([ChannelId.UI, ChannelId.STATE]);
  });

  it('says nothing when the witness DID see it', () => {
    const row = { channel: ChannelId.STATE, at: 1, data: { id: 42 } } as unknown as Observation;
    expect(
      witnessDisagreement(actorSaid(), { channel: ChannelId.STATE, observed: [row] }),
    ).toBeUndefined();
  });

  it('says nothing when the witness could not look, rather than convicting on its silence', () => {
    // The difference that decides whether this is evidence at all. A witness that was DOWN saw
    // nothing for a reason that has nothing to do with the app, and reporting that as "the write
    // never happened" would be the protocol inventing a defect out of its own blind spot.
    const anomaly = witnessDisagreement(actorSaid(), {
      channel: ChannelId.STATE,
      observed: [],
      blind: [
        {
          kind: BlindSpotKind.CHANNEL_UNOBSERVED,
          channel: ChannelId.STATE,
          detail: 'db unreachable',
          impeaching: true,
        },
      ],
    });
    expect(anomaly).toBeUndefined();
  });
});

describe('the verdict a witness disagreement produces', () => {
  it('is NO, not a pass, even though every assertion held', () => {
    const anomaly = witnessDisagreement(actorSaid(), { channel: ChannelId.STATE, observed: [] });
    const outcome = adjudicate({
      claim: {
        id: 'c1',
        text: CLAIM,
        reads: [ChannelId.UI],
        declaredBefore: true,
        assertions: [{ id: 'a1', text: CLAIM, channels: [ChannelId.UI] }],
      },
      channels: [
        { ...CHANNEL_DEFAULTS, id: ChannelId.UI, grade: Grade.CONSEQUENCE },
        {
          ...CHANNEL_DEFAULTS,
          id: ChannelId.STATE,
          independence: Independence.INDEPENDENT,
          grade: Grade.CONSEQUENCE,
        },
      ],
      evidence: [],
      anomalies: anomaly === undefined ? [] : [anomaly],
      assertionsHeld: true,
      window: {
        id: 'w1',
        openedAt: 0,
        budgetMs: 100,
        closes: CloseCondition.QUIESCENCE,
        subject: { surface: Surface.WEB, instance: 'app', epoch: 1 },
      },
      coverage: { window: 'w1', observed: [ChannelId.UI], blindSpots: [] },
    } as unknown as Parameters<typeof adjudicate>[0]);
    expect(outcome.verdict).toBe(Verdict.NO);
  });
});
