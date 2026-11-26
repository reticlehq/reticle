import { describe, expect, it } from 'vitest';
import { ambientRecordingOf, RecordingStore, type RecordedStep } from './recordings.js';

/**
 * Recording a SUB-FLOW, so a composite can be authored by driving rather than by hand.
 *
 * `capture` already appends to every in-flight recording, which means a nested span is captured
 * twice: once in the sub-flow, and once INLINED into whatever was recording around it. Inlined is
 * the wrong answer — it produces a composite-shaped journey with none of composition's value. The
 * outer document would repeat the steps rather than invoke the document that owns them, so a drift
 * still reports "step 34 of onboarding", repair still has to happen in every copy, and the sub-flow
 * cannot be reused.
 *
 * What the outer recording wants instead is a single step saying "this part is `onboarding/signup`,
 * go and run that". The boundary is where the nested recording STOPS, because that is the moment
 * the sub-journey is known to be complete and to have a name.
 */

const step = (id: string): RecordedStep => ({ tool: 'reticle_act', args: { id }, stable: true });

describe('recording a sub-flow inside another', () => {
  it('replaces the nested span in the outer recording with one invoke', () => {
    const store = new RecordingStore();
    store.start('onboarding/full', 0);
    store.capture(step('before'));

    store.start('onboarding/signup', 1);
    store.capture(step('typed-email'));
    store.capture(step('submitted'));
    const inner = store.stop('onboarding/signup');

    store.capture(step('after'));
    const outer = store.stop('onboarding/full');

    // The sub-flow keeps its own steps, entire.
    expect(inner?.steps.map((s) => s.args['id'])).toEqual(['typed-email', 'submitted']);
    // The outer replaces them with the invocation, and keeps what it drove itself.
    expect(outer?.steps.map((s) => s.invoke ?? s.args['id'])).toEqual([
      'before',
      'onboarding/signup',
      'after',
    ]);
  });

  it('leaves a recording with no parent completely alone', () => {
    const store = new RecordingStore();
    store.start('solo', 0);
    store.capture(step('a'));
    expect(store.stop('solo')?.steps.map((s) => s.args['id'])).toEqual(['a']);
  });

  it('nests three deep, each level invoking the one below', () => {
    const store = new RecordingStore();
    store.start('top', 0);
    store.start('mid', 0);
    store.start('leaf', 0);
    store.capture(step('deep'));
    store.stop('leaf');
    store.stop('mid');
    const top = store.stop('top');
    // `top` names `mid`, not `leaf` — each level knows only the one it opened.
    expect(top?.steps.map((s) => s.invoke)).toEqual(['mid']);
  });

  it('does not invoke a recording that started BEFORE the outer one', () => {
    // Overlapping spans are not nesting. `late` did not contain `early`, so `late` must not claim
    // to invoke it — a document that invokes something it never drove replays a journey nobody took.
    const store = new RecordingStore();
    store.start('early', 0);
    store.capture(step('a'));
    store.start('late', 1);
    store.capture(step('b'));
    store.stop('early');
    expect(store.stop('late')?.steps.map((s) => s.invoke ?? s.args['id'])).toEqual(['b']);
  });

  // The ambient tape is saved on its own at session end, and the recording closed inside it may
  // never be saved: an invoke there names a document that does not exist (#2493).
  it('keeps the real steps on the ambient tape instead of an invoke', () => {
    const store = new RecordingStore();
    store.capture(step('open-drawer'), undefined, 's1');

    store.start('close-drawer', 1, undefined, 's1');
    store.capture(step('closed'), undefined, 's1');
    store.stop('close-drawer');

    store.capture(step('cancel'), undefined, 's1');
    const ambient = store.stop(ambientRecordingOf('s1'));

    expect(ambient?.steps.map((s) => s.invoke ?? s.args['id'])).toEqual([
      'open-drawer',
      'closed',
      'cancel',
    ]);
  });
});
