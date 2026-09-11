import { describe, expect, it } from 'vitest';
import { ServiceRealm, type ServiceCall, type ServiceRealmPorts } from './service-realm.js';
import { adjudicate } from '../spi/adjudicator.js';
import { ChannelId, Grade } from '../vocabulary/channel.js';
import { Declaration } from '../vocabulary/intent.js';
import { CloseCondition, RefusalReason } from '../vocabulary/realm-surface.js';
import { ProvenanceClass } from '../vocabulary/evidence.js';
import { evaluate, MeasureOp, PredicateKind } from '../vocabulary/predicate.js';
import { Verdict, reviseVerdict } from '../vocabulary/verdict.js';
import { profileFromChannels, Profile } from '../registry.js';

/**
 * A realm with no screen, driven end to end through the same adjudicator the browser uses.
 *
 * This is the specification's central claim under test. If the rules are realm-blind then a
 * service realm -- no DOM, no elements, no quiescence, nothing to photograph -- reaches correct
 * verdicts through exactly the same function, with no special case anywhere. If it needs one, the
 * abstraction was a browser wearing a general name and this is where that shows.
 */

let clock = 1_000;
const calls: ServiceCall[] = [];
const logs: { level: string; message: string; at: number }[] = [];

function ports(over: Partial<ServiceRealmPorts> = {}): ServiceRealmPorts {
  return {
    instance: () => ({ id: 'orders-7f2', deploy: 'a1b2c3' }),
    epoch: () => 4,
    commands: [
      {
        name: 'place_order',
        meaning: 'place an order',
        mutating: true,
        call: async () => calls[calls.length - 1] ?? placed(200),
      },
    ],
    callsSince: (at) => calls.filter((c) => c.at >= at),
    logSince: (at) => logs.filter((l) => l.at >= at),
    now: () => clock,
    ...over,
  };
}

function placed(status: number, pendingAt?: string): ServiceCall {
  return {
    method: 'POST',
    target: '/orders',
    status,
    body: { id: 'o1' },
    ...(pendingAt === undefined ? {} : { pendingAt }),
    at: clock,
  };
}

const claim = {
  id: 'c1',
  statement: 'the order was placed',
  declaredAt: Declaration.BEFORE_ACTION,
  assertions: [
    { id: 'a1', predicate: {}, reads: 'POST /orders returned 2xx', channels: [ChannelId.NET] },
  ],
};

function reset() {
  clock = 1_000;
  calls.length = 0;
  logs.length = 0;
}

/** Drive one action and adjudicate what came back, exactly as a decider would. */
async function drive(realm: ServiceRealm, assertionsHeld: boolean) {
  const window = realm.openWindow(8_000);
  await realm.perform({ id: 'a1', actor: 'test', capability: 'place_order', at: clock });
  clock += 40;
  const closed = realm.closeWindow(window);
  const observations = await realm.observe(closed);
  const coverage = await realm.coverage(closed);
  const evidence = observations
    .filter((o) => o.channel === ChannelId.NET)
    .map((o) => ({
      observation: o,
      provenance: {
        class: ProvenanceClass.OBSERVED,
        source: 'boundary',
        method: 'proxy',
        subject: realm.identity(),
        at: o.at,
      },
      independence: 'independent' as const,
      grade: Grade.CONSEQUENCE,
    }));
  return {
    window: closed,
    coverage,
    result: adjudicate({
      claim,
      window: closed,
      channels: realm.channels(),
      evidence,
      coverage,
      anomalies: [],
      assertionsHeld,
    }),
  };
}

describe('a realm with no screen reaches verdicts through the same rules', () => {
  it('proves a claim from independent boundary evidence', async () => {
    reset();
    calls.push(placed(200));
    const { result } = await drive(new ServiceRealm(ports()), true);
    expect(result.verdict).toBe(Verdict.YES);
    expect(result.grade).toBe(Grade.CONSEQUENCE);
  });

  it('disproves one when the assertion failed', async () => {
    reset();
    calls.push(placed(500));
    const { result } = await drive(new ServiceRealm(ports()), false);
    expect(result.verdict).toBe(Verdict.NO);
  });

  it('closes on acknowledgement, not on silence', async () => {
    // The generalisation the whole design turns on. A service is never quiet -- health checks,
    // other tenants, background work -- so a quiescence-only engine waits out the budget and then
    // reports a give-up on a service that answered correctly in forty milliseconds.
    reset();
    calls.push(placed(200));
    const { window } = await drive(new ServiceRealm(ports()), true);
    expect(window.closes).toBe(CloseCondition.ACK);
    expect(window.closedBy).toBe(CloseCondition.ACK);
  });

  it('says budget-exhausted when nothing ever acknowledged, and cannot then prove', async () => {
    reset();
    const realm = new ServiceRealm(ports());
    const window = realm.openWindow(10);
    clock += 5_000;
    const closed = realm.closeWindow(window);
    expect(closed.closedBy).toBe(CloseCondition.BUDGET_EXHAUSTED);
    const result = adjudicate({
      claim,
      window: closed,
      channels: realm.channels(),
      evidence: [],
      coverage: await realm.coverage(closed),
      anomalies: [],
      assertionsHeld: true,
    });
    expect(result.verdict).toBe(Verdict.UNKNOWN);
  });
});

describe('accepted-but-not-finished is answered honestly, then corrected', () => {
  it('is unknown while the outcome has not arrived, naming where it will', async () => {
    // The scenario a two-valued verifier cannot express. 202 means the truth has not arrived;
    // yes and no are both inventions.
    reset();
    calls.push(placed(202, '/orders/o1/status'));
    const { result, coverage } = await drive(new ServiceRealm(ports()), true);
    expect(result.verdict).toBe(Verdict.UNKNOWN);
    const pending = coverage.blindSpots.find((s) => s.kind === 'still-in-flight');
    expect(pending?.impeaching).toBe(true);
    expect(pending?.detail).toContain('/orders/o1/status');
  });

  it('supersedes that verdict when the outcome lands, without editing it', async () => {
    reset();
    calls.push(placed(202, '/orders/o1/status'));
    const first = await drive(new ServiceRealm(ports()), true);
    const earlier = {
      id: 'v1',
      claim: claim.id,
      window: first.window.id,
      verdict: first.result.verdict,
      reasons: [...first.result.reasons],
      evidence: [],
      anomalies: [],
      at: clock,
    };

    // The outcome arrives later, through a channel nobody was holding open.
    clock += 5_000;
    const corrected = reviseVerdict(earlier, 'run-1', {
      id: 'v2',
      verdict: Verdict.YES,
      grade: Grade.CONSEQUENCE,
      reasons: ['the reconciliation endpoint reported the order settled'],
      at: clock,
    });

    expect(corrected.supersedes).toBe('run-1#v1');
    expect(corrected.verdict).toBe(Verdict.YES);
    // And the first answer still stands, exactly as it was given.
    expect(earlier.verdict).toBe(Verdict.UNKNOWN);
    expect(earlier.reasons).toEqual(first.result.reasons);
  });

  it('stops calling it pending once the reconcile deadline passes', async () => {
    reset();
    calls.push(placed(202, '/orders/o1/status'));
    const realm = new ServiceRealm(ports());
    const window = realm.openWindow(8_000);
    clock += 60_000;
    const coverage = await realm.coverage(window);
    // No longer "still in flight" — the honest statement is that the effect is somewhere this
    // vantage point cannot follow, which is about our reach and not about the service.
    expect(coverage.blindSpots.some((s) => s.kind === 'effect-elsewhere')).toBe(true);
    expect(coverage.blindSpots.some((s) => s.kind === 'still-in-flight')).toBe(false);
  });
});

describe('the realm is honest about what it is', () => {
  it('earns the effect profile and claims no more', async () => {
    // It cannot read the service's memory, so `in-realm` is not available to it. That is a true
    // statement about a vantage point, not a deficiency, and the profile exists to say it.
    const realm = new ServiceRealm(ports());
    expect(profileFromChannels(realm.channels())).toBe(Profile.EFFECT);
  });

  it('declares the channel it does not watch, without impeaching claims that never read it', async () => {
    reset();
    const realm = new ServiceRealm(ports());
    const coverage = await realm.coverage(realm.openWindow(1_000));
    const state = coverage.blindSpots.find((s) => s.channel === ChannelId.STATE);
    expect(state?.impeaching).toBe(false);
    expect(state?.remedy).toContain('in-realm');
  });

  it('refuses a capability it never declared, without the implementation being consulted', async () => {
    reset();
    const receipt = await new ServiceRealm(ports()).perform({
      id: 'a9',
      actor: 'test',
      capability: 'delete_everything',
      at: clock,
    });
    expect(receipt.dispatched).toBe(false);
    expect(receipt.refused?.reason).toBe(RefusalReason.UNDECLARED);
  });

  it('has no photograph, and the interface does not make it fake one', async () => {
    // An interface requiring this would have every non-visual realm return an empty buffer, and an
    // empty buffer saved as a baseline is a comparison that passes forever.
    expect(new ServiceRealm(ports()).photograph).toBeUndefined();
  });

  it('ties identity to the deploy, so a redeploy invalidates the evidence before it', () => {
    const a = new ServiceRealm(ports()).identity();
    const b = new ServiceRealm(
      ports({ instance: () => ({ id: 'orders-7f2', deploy: 'd4e5f6' }) }),
    ).identity();
    expect(a.instance).not.toBe(b.instance);
  });
});

/**
 * The reference realm emits a measurable quantity, so `measure` is exercised by a realm rather
 * than only by hand-built observations.
 *
 * `measure` was added because every domain outside a browser claims numbers, and a predicate
 * form that only unit tests ever reach would be one more thing defined and reached by nobody,
 * which is the defect this release spent its length finding. This realm is where the
 * specification proves its own vocabulary: it exists because "a specification whose only
 * implementation is the author's flagship has demonstrated nothing".
 *
 * The quantity is latency from window open to the call being observed, which needs no new
 * input — `ServiceCall.at` and `Window.openedAt` are both already there. It is the quantity a
 * service claim actually names: *the write landed within 300 ms of the action*.
 *
 * The unit rides on the summary, `service.call.latency.ms`, because the specification has no
 * unit field on purpose: a unit the engine could not check would be a field that exists to be
 * ignored, and two implementations disagreeing about it would disagree silently.
 */
describe('a measured quantity, produced by a realm rather than by a fixture', () => {
  it('emits a numeric latency observation alongside the call it describes', async () => {
    reset();
    const realm = new ServiceRealm(ports());
    const window = realm.openWindow(8_000);
    // The port records nothing by itself; a call exists because the service made one.
    clock += 40;
    calls.push(placed(200));
    await realm.perform({ id: 'a1', actor: 'test', capability: 'place_order', at: clock });
    const observations = await realm.observe(realm.closeWindow(window));
    const latency = observations.filter((o) => o.summary === 'service.call.latency.ms');
    expect(latency.length, 'the realm emitted no latency observation').toBeGreaterThan(0);
    for (const o of latency) expect(typeof o.value).toBe('number');
  });

  it('answers a measure predicate over what the realm actually reported', async () => {
    reset();
    const realm = new ServiceRealm(ports());
    const window = realm.openWindow(8_000);
    clock += 40;
    calls.push(placed(200));
    await realm.perform({ id: 'a1', actor: 'test', capability: 'place_order', at: clock });
    const observations = await realm.observe(realm.closeWindow(window));
    const within = (ms: number, tolerance: number): boolean | undefined =>
      evaluate(
        {
          kind: PredicateKind.MEASURE,
          match: { channel: ChannelId.NET, summary: 'service.call.latency.ms' },
          op: MeasureOp.AT_MOST,
          value: ms,
          tolerance,
        },
        observations,
      );
    // A generous bound holds and a mean one does not, which together prove the predicate is
    // reading the realm's number rather than answering the same way whatever it is given.
    expect(within(10_000, 0)).toBe(true);
    expect(within(-1, 0)).toBe(false);
  });
});
