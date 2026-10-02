import { describe, expect, it } from 'vitest';
import { RecordingStore, AMBIENT_RECORDING } from './recordings.js';

/**
 * Nothing an agent drives is ever thrown away for want of somebody calling record_start.
 *
 * Recording used to be opt-in: `capture()` appended to every ACTIVE recording, and with none active
 * that loop ran zero times and the step was gone. So the flow an agent could have kept — the one
 * that would have become a regression test, for free, from work it was doing anyway — existed only
 * when the agent remembered a tool. Telling agents to remember is a rule, and a rule that has to be
 * remembered on every drive is one that is followed on some of them.
 *
 * So the store keeps an AMBIENT recording. It starts itself on the first captured step and it is
 * always there. Explicit recordings are unaffected: they still start, nest and stop exactly as
 * before, and a step still belongs to every span in flight, the ambient one included.
 *
 * This buys nothing on its own — an unnamed tape is not a test. It is the precondition: you cannot
 * offer to keep a journey you did not record, and you cannot learn an assertion from a drive you
 * did not watch.
 */
describe('the store is always recording', () => {
  const step = (tool: string): Parameters<RecordingStore['capture']>[0] =>
    ({ tool, args: {} }) as Parameters<RecordingStore['capture']>[0];

  it('keeps a step captured when nobody started a recording', () => {
    const store = new RecordingStore();
    store.capture(step('reticle_act'));
    expect(store.stepCount(AMBIENT_RECORDING)).toBe(1);
  });

  it('is recording from the very first step, without being asked', () => {
    const store = new RecordingStore();
    expect(store.isRecording(AMBIENT_RECORDING)).toBe(false);
    store.capture(step('reticle_act'));
    expect(store.isRecording(AMBIENT_RECORDING)).toBe(true);
  });

  it('does not disturb an explicit recording — a step belongs to both', () => {
    const store = new RecordingStore();
    store.start('checkout', 0);
    store.capture(step('reticle_act'));
    expect(store.stepCount('checkout')).toBe(1);
    expect(store.stepCount(AMBIENT_RECORDING)).toBe(1);
  });

  it('survives an explicit recording being stopped — the tape does not end with it', () => {
    // The case that matters: an agent records a named flow, stops it, then keeps driving. Those
    // later steps are exactly as worth keeping as the earlier ones.
    const store = new RecordingStore();
    store.start('checkout', 0);
    store.capture(step('reticle_act'));
    store.stop('checkout');
    store.capture(step('reticle_act_and_wait'));
    expect(store.stepCount(AMBIENT_RECORDING)).toBe(2);
  });

  it('can be taken and keeps going, so a long session is not one unbounded tape', () => {
    const store = new RecordingStore();
    store.capture(step('reticle_act'));
    const taken = store.stop(AMBIENT_RECORDING);
    expect(taken?.steps).toHaveLength(1);
    store.capture(step('reticle_act'));
    expect(store.stepCount(AMBIENT_RECORDING)).toBe(1);
  });

  it('is not offered as a name an agent can start or collide with', () => {
    // Reserved: an agent naming its flow this would silently merge with the ambient tape.
    expect(AMBIENT_RECORDING.startsWith('__')).toBe(true);
  });
});
