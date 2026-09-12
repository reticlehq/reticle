/**
 * Replay must not be stricter than the tool that recorded the step.
 *
 * The wait for a step's declared consequence was a fixed 4s with no way to raise it, and that is not
 * a tuning knob — it decides whether an honest flow can ever be green. Two field reports, the same
 * shape: a login whose POST measures 5.5s against a remote Postgres, and a CAD import whose
 * model-backed perception takes ~22s. Both verified live with `act_and_wait { timeout_ms }`, both
 * drifted on replay at ~4020ms with `signal_not_observed`, and both were reported to the user as NO
 * LONGER TRUE — a working feature called a regression. The only ways to green them were to weaken or
 * delete the assertion, which the rules correctly forbid, so the flow stayed honest and permanently
 * red. One agent tried a step-level `timeout_ms` and an `expect.timeout_ms`; both were dropped in
 * silence, which is the worse half — a knob that reads as accepted and does nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  FLOW_SIGNAL_TIMEOUT_MS,
  type CommandResult,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate } from '../events/predicate.js';

const SIGNAL = 'geometry:perceived';

/**
 * A session whose signal lands only after `arrivesAtMs` of wall time — the app that is simply slow,
 * not broken. The timer fires the listener the predicate engine subscribes with, so the wait ends on
 * the event rather than on a poll.
 */
class SlowSession implements FlowReplaySession {
  readonly #listeners = new Set<(event: ReticleEvent) => void>();
  #arrived = false;
  readonly #timer: ReturnType<typeof setTimeout>;

  constructor(arrivesAtMs: number) {
    this.#timer = setTimeout(() => {
      this.#arrived = true;
      for (const listener of this.#listeners) listener(SIGNAL_EVENT);
    }, arrivesAtMs);
  }
  dispose(): void {
    clearTimeout(this.#timer);
  }
  command(): Promise<CommandResult> {
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  }
  eventsSince(): ReticleEvent[] {
    return this.#arrived ? [SIGNAL_EVENT] : [];
  }
  onEvent(listener: (event: ReticleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  elapsed(): number {
    return 0;
  }
}

const SIGNAL_EVENT: ReticleEvent = {
  t: 1,
  type: EventType.SIGNAL,
  sessionId: 's',
  data: { name: SIGNAL },
};

const flow = (over: Partial<FlowFile> = {}): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'import-geometry',
  createdAt: 0,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.SIGNAL, name: SIGNAL } }],
  ...over,
});

/** Late enough that the built-in default cannot see it, early enough to keep the test quick. */
const LATE = 200;
const GENEROUS = 3000;

describe('a step declares how long its consequence takes', () => {
  it('drifts on the built-in default when the app is slower than it', async () => {
    const steps = await replayFlow(new SlowSession(LATE), flow(), waitForPredicate, 40);
    expect(steps[0]?.ok, 'the default wait is what produced the false red').toBe(false);
  });

  it('passes when the STEP declares the longer wait', async () => {
    const f = flow();
    const [step] = f.steps;
    if (step !== undefined) step.timeoutMs = GENEROUS;
    const steps = await replayFlow(new SlowSession(LATE), f, waitForPredicate, 40);
    expect(steps[0]?.ok).toBe(true);
    expect(steps[0]?.drift).toBeUndefined();
  });

  it('passes when the FLOW declares it, for an app that is slow throughout', async () => {
    const steps = await replayFlow(
      new SlowSession(LATE),
      flow({ signalTimeoutMs: GENEROUS }),
      waitForPredicate,
      40,
    );
    expect(steps[0]?.ok).toBe(true);
  });

  it('lets a step override the flow, so one slow step does not slow the suite', async () => {
    const f = flow({ signalTimeoutMs: 40 });
    const [step] = f.steps;
    if (step !== undefined) step.timeoutMs = GENEROUS;
    const steps = await replayFlow(new SlowSession(LATE), f, waitForPredicate, 40);
    expect(steps[0]?.ok).toBe(true);
  });

  it('leaves a flow that declares nothing on the shipped default', () => {
    expect(FLOW_SIGNAL_TIMEOUT_MS).toBe(4000);
    expect(flow().signalTimeoutMs).toBeUndefined();
  });
});
