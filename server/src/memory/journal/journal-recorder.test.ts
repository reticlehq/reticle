import { describe, expect, it } from 'vitest';
import {
  EventAttribution,
  EventType,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';
import { JournalRecorder, type JournalSink } from './journal-recorder.js';

function evt(seq: number): ReticleEvent {
  return { t: seq, seq, type: EventType.NET_REQUEST, sessionId: 'demo', data: {} };
}

/** A fake sink that records batches and actions in call order, for asserting attribution + ordering. */
function fakeSink(): JournalSink & {
  events: ReticleEvent[];
  actions: JournalAction[];
  log: string[];
} {
  const events: ReticleEvent[] = [];
  const actions: JournalAction[] = [];
  const log: string[] = [];
  return {
    events,
    actions,
    log,
    appendEvents(batch) {
      events.push(...batch);
      log.push(`events:${batch.length}`);
      return Promise.resolve();
    },
    appendAction(action) {
      actions.push(action);
      log.push(`action:${action.actionId}`);
      return Promise.resolve();
    },
  };
}

/** Injectable elapsed clock returning preset values in sequence, last value sticking. */
function stepClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe('JournalRecorder', () => {
  it('journals ambient events with no attribution when no action is active', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0, flushAt: 100 });
    const out = rec.observe(evt(0));
    expect(out.actionId).toBeUndefined();
    await rec.flush();
    expect(sink.events).toHaveLength(1);
    expect(sink.actions).toHaveLength(0);
  });

  it('attributes events inside an action window and records seqRange + tRange', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: stepClock([10, 42]), flushAt: 100 });
    rec.beginAction('c1', 'reticle_act', { ref: 'e7' }); // now->10 (tStart)
    const a = rec.observe(evt(3));
    const b = rec.observe(evt(5));
    expect(a.actionId).toBe('c1');
    expect(a.attribution).toBe(EventAttribution.WINDOW);
    expect(b.actionId).toBe('c1');
    rec.finishAction({ glyph: 'pass' }, true, 32); // now->42 (tEnd)
    await rec.flush();
    const action = sink.actions[0];
    expect(action?.actionId).toBe('c1');
    expect(action?.seqRange).toEqual({ from: 3, to: 5 });
    expect(action?.tRange).toEqual({ from: 10, to: 42 });
    expect(action?.settled).toBe(true);
    expect(action?.settledInMs).toBe(32);
  });

  it('flushes attributed events before the action that closes them (ordering)', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0, flushAt: 100 });
    rec.beginAction('c1', 'reticle_act', {});
    rec.observe(evt(0));
    rec.finishAction();
    await rec.flush();
    expect(sink.log).toEqual(['events:1', 'action:c1']);
  });

  it('finishAction with no active action is a no-op', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0 });
    rec.finishAction();
    await rec.flush();
    expect(sink.actions).toHaveLength(0);
  });

  it('auto-flushes a batch once flushAt events accumulate', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0, flushAt: 2 });
    rec.observe(evt(0));
    rec.observe(evt(1)); // reaches flushAt -> flush
    await rec.flush();
    expect(sink.events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('an action with no observed events records no seqRange', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0 });
    rec.beginAction('c9', 'reticle_navigate', {});
    rec.finishAction();
    await rec.flush();
    expect(sink.actions[0]?.seqRange).toBeUndefined();
  });
});

/**
 * A verdict tool that drives nothing still has to leave a record, or a later turn is told nothing was
 * proven and re-proves it — or, worse, assumes it. The constraint is that recording must not open an
 * attribution window: an assertion causes no events, so stamping the ones that arrive during it would
 * invent a causal link that never existed.
 */
describe('JournalRecorder.recordAction (a verdict with no window)', () => {
  it('writes the action record with its effect', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 7, flushAt: 100 });
    rec.recordAction('a4', 'reticle_assert', { predicate: {} }, { claim: 'the row is gone' });
    await rec.flush();
    const action = sink.actions[0];
    expect(action?.actionId).toBe('a4');
    expect(action?.tool).toBe('reticle_assert');
    expect(action?.effect).toEqual({ claim: 'the row is gone' });
    expect(action?.at).toBe(7);
  });

  it('omits seqRange and records an empty tRange — no window, so nothing was attributed', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 7, flushAt: 100 });
    rec.recordAction('a4', 'reticle_assert', {}, {});
    await rec.flush();
    expect(sink.actions[0]?.seqRange).toBeUndefined();
    expect(sink.actions[0]?.tRange).toEqual({ from: 7, to: 7 });
    expect(sink.actions[0]?.settled).toBeUndefined();
  });

  it('does NOT open a window — a later event stays unattributed', () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0, flushAt: 100 });
    rec.recordAction('a4', 'reticle_assert', {}, {});
    const after = rec.observe(evt(9));
    expect(after.actionId).toBeUndefined();
    expect(after.attribution).toBeUndefined();
  });

  it('leaves an in-flight action window untouched', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: stepClock([10, 20, 42]), flushAt: 100 });
    rec.beginAction('c1', 'reticle_act_and_wait', {});
    const before = rec.observe(evt(3));
    rec.recordAction('a2', 'reticle_assert', {}, {});
    const after = rec.observe(evt(5));
    rec.finishAction({ claim: 'the toast is visible' }, true);
    await rec.flush();
    expect(before.actionId).toBe('c1');
    expect(after.actionId).toBe('c1');
    expect(after.attribution).toBe(EventAttribution.WINDOW);
    const window = sink.actions.find((a) => 'c1' === a.actionId);
    expect(window?.seqRange).toEqual({ from: 3, to: 5 });
  });

  it('flushes buffered events before the record, so ordering holds', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0, flushAt: 100 });
    rec.observe(evt(0));
    rec.recordAction('a1', 'reticle_assert', {}, {});
    await rec.flush();
    expect(sink.log).toEqual(['events:1', 'action:a1']);
  });
});
