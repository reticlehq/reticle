/**
 * A request still on the wire when the budget ends is not a call that never happened.
 *
 * Reported from the field. Replay said:
 *
 *     verdict: "drift"
 *     whatChanged: "no network call matched {kind:net, method:POST, urlContains:/geometry, status:200}"
 *
 * while `reticle_network` showed, at that same moment:
 *
 *     POST /api/v0/interview/itv_.../geometry   status: "pending"
 *
 * The request existed and was on the wire. The replayer had already given up and called it drift,
 * which reads to a user as "this feature regressed" when the truth is "the wait ended before the app
 * did" (#896).
 *
 * `fix(server): an in-flight named request is not a failed assertion` drew exactly this line for
 * `reticle_assert`. Replay never got it, so the two paths disagreed about the same fact. This reuses
 * `namedNetIsInFlight` rather than reimplementing the match, so they cannot drift apart again.
 *
 * The verdict stays a DRIFT. The step did not prove its consequence and pretending otherwise would
 * be the opposite error. What changes is the reason kind, and therefore what a reader is sent to do:
 * raise a budget, rather than hunt for deleted code.
 */
import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  DriftReason,
  EventType,
  FLOW_FILE_VERSION,
  ReticleCommand,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
  type ReticleEvent,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate } from '../events/predicate.js';

const URL_MATCHED = 'https://app.test/api/v0/interview/itv_38e855c1/geometry';

/** A request that STARTED and never completed: a NET_PENDING with no matching NET_REQUEST. */
const pendingPost = (url: string, method = 'POST'): ReticleEvent => ({
  t: 1,
  type: EventType.NET_PENDING,
  sessionId: 's',
  data: { id: `r-${url}-${method}`, method, url, initiator: 'fetch' },
});

/** One live element, so the step's anchor resolves and the run reaches its `expect`. */
const ELEMENT = {
  ref: 'e1',
  role: 'button',
  name: 'Import',
  states: [],
  visible: true,
} as unknown as ElementDescriptor;

/**
 * A session whose buffer holds whatever the test puts on the wire, and nothing else.
 *
 * The anchor always resolves and the act always succeeds: every test here is about what happens
 * AFTER that, when the declared consequence's budget runs out.
 */
class WireSession implements FlowReplaySession {
  readonly #events: ReticleEvent[];
  constructor(events: ReticleEvent[] = []) {
    this.#events = events;
  }
  command(name: string): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: { elements: [ELEMENT], count: 1 },
      });
    }
    if (name === ReticleCommand.MATCH) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'm',
        ok: true,
        result: { matched: true, count: 1, elements: [ELEMENT] },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: { ok: true } });
  }
  eventsSince(): ReticleEvent[] {
    return this.#events;
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 0;
  }
}

const flowExpecting = (net: Record<string, unknown>): FlowFile => {
  const step: FlowStep = {
    tool: 'reticle_act',
    anchor: { kind: AnchorKind.TESTID, value: 'import' },
  };
  step.expect = { net };
  return { version: FLOW_FILE_VERSION, name: 'import-geometry', createdAt: 0, steps: [step] };
};

/** Short, so a test that is meant to time out does so quickly. */
const BUDGET = 40;

describe("a wait that expires with the step's own request still open", () => {
  it('does not report the call as one that never happened', async () => {
    const session = new WireSession([pendingPost(URL_MATCHED)]);

    const [step] = await replayFlow(
      session,
      flowExpecting({ method: 'POST', urlContains: '/geometry', status: 200 }),
      waitForPredicate,
      BUDGET,
    );

    expect(step?.ok, 'the consequence did not hold, so this is still a drift').toBe(false);
    expect(step?.drift?.reasonKind).toBe(DriftReason.REQUEST_STILL_IN_FLIGHT);
    expect(step?.drift?.reasonKind).not.toBe(DriftReason.SIGNAL_NOT_OBSERVED);
  });

  it('names the pending call, so the claim can be checked', async () => {
    const session = new WireSession([pendingPost(URL_MATCHED)]);

    const [step] = await replayFlow(
      session,
      flowExpecting({ method: 'POST', urlContains: '/geometry', status: 200 }),
      waitForPredicate,
      BUDGET,
    );

    expect(step?.drift?.reason).toContain('STILL IN FLIGHT');
    expect(step?.drift?.reason).toContain('/geometry');
  });

  it('sends the reader to a budget rather than to a regression', async () => {
    const session = new WireSession([pendingPost(URL_MATCHED)]);

    const [step] = await replayFlow(
      session,
      flowExpecting({ method: 'POST', urlContains: '/geometry', status: 200 }),
      waitForPredicate,
      BUDGET,
    );

    expect(step?.drift?.reason).toContain('timeoutMs');
    expect(step?.drift?.reason).toContain('signalTimeoutMs');
    // The sentence that produced the false reading. It may be denied, as it is here, but it must
    // not be the whole message the way it was.
    expect(step?.drift?.reason).not.toContain('no network call matched');
  });
});

describe('what the excuse must not pardon', () => {
  it('keeps the ordinary miss when nothing is on the wire', async () => {
    const session = new WireSession([]);

    const [step] = await replayFlow(
      session,
      flowExpecting({ method: 'POST', urlContains: '/geometry', status: 200 }),
      waitForPredicate,
      BUDGET,
    );

    expect(step?.drift?.reasonKind).toBe(DriftReason.SIGNAL_NOT_OBSERVED);
  });

  it('keeps the ordinary miss when an UNRELATED request is hanging', async () => {
    // A dashboard poll left open must not pardon a named URL that never started. This is the whole
    // reason the check matches rather than asking "is anything pending".
    const session = new WireSession([pendingPost('https://app.test/api/v0/notifications')]);

    const [step] = await replayFlow(
      session,
      flowExpecting({ method: 'POST', urlContains: '/geometry', status: 200 }),
      waitForPredicate,
      BUDGET,
    );

    expect(step?.drift?.reasonKind).toBe(DriftReason.SIGNAL_NOT_OBSERVED);
  });

  it('keeps the ordinary miss when the pending call uses a different method', async () => {
    const session = new WireSession([pendingPost(URL_MATCHED, 'GET')]);

    const [step] = await replayFlow(
      session,
      flowExpecting({ method: 'POST', urlContains: '/geometry', status: 200 }),
      waitForPredicate,
      BUDGET,
    );

    expect(step?.drift?.reasonKind).toBe(DriftReason.SIGNAL_NOT_OBSERVED);
  });

  it('does not fire for a completed request that simply did not match', async () => {
    // The call finished with the wrong status. The app answered; that is a real finding.
    const session = new WireSession([
      {
        t: 2,
        type: EventType.NET_REQUEST,
        sessionId: 's',
        data: { id: 'r1', method: 'POST', url: URL_MATCHED, status: 500 },
      },
    ]);

    const [step] = await replayFlow(
      session,
      flowExpecting({ method: 'POST', urlContains: '/geometry', status: 200 }),
      waitForPredicate,
      BUDGET,
    );

    expect(step?.drift?.reasonKind).toBe(DriftReason.SIGNAL_NOT_OBSERVED);
  });
});
