/**
 * A native dialog must not be able to wedge a driven session.
 *
 * `window.confirm()` blocks the main thread until something answers it. Nothing in the page can —
 * the SDK's own message pump is on that same thread — so one `confirm` behind a driven click killed
 * the tab permanently: `reticle_sessions` reported `unresponsive: true`, every `reticle_navigate`
 * including `reload: true, hard: true` timed out at 8000ms, and `session end` did not revive it. The
 * documented recovery (`reticle_lease acquire`) opens a DIFFERENT tab, so on the reported session —
 * the only authenticated one — there was no way back at all.
 *
 * The fix is scoped to Reticle's own dispatches. A dialog a PERSON opened is theirs: they can see it
 * and click it, and intercepting it would change how the app behaves for the human whose page this
 * is. `isSyntheticInput()` already distinguishes the two, and `confirm()` called from a click
 * handler runs synchronously inside the dispatch, so the flag is exact rather than a heuristic.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installDialogs } from './dialogs.js';
import { asSyntheticInput } from '../actions/synthetic/synthetic-input.js';
import type { Emit, Teardown } from './types.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}
function collect(): { emit: Emit; events: Emitted[] } {
  const events: Emitted[] = [];
  return { emit: (type, data) => void events.push({ type, data }), events };
}

describe('installDialogs', () => {
  let teardown: Teardown | undefined;
  // Captured through the same structural view the observer uses: reading `window.confirm` as a
  // property reference trips `unbound-method`, and these are restored by assignment, never called.
  type Slots = Record<'alert' | 'confirm' | 'prompt', unknown>;
  const slots = window as unknown as Slots;
  const native: Slots = { alert: slots.alert, confirm: slots.confirm, prompt: slots.prompt };
  afterEach(() => {
    teardown?.();
    teardown = undefined;
    slots.alert = native.alert;
    slots.confirm = native.confirm;
    slots.prompt = native.prompt;
  });

  it('answers a confirm opened by a DRIVEN action instead of blocking', () => {
    const { emit, events } = collect();
    teardown = installDialogs(emit);
    const answer = asSyntheticInput(() => window.confirm('Delete this item?'));
    expect(
      answer,
      'cancel is the non-destructive answer, and never a guess in the app’s favour',
    ).toBe(false);
    const dialog = events.find((e) => e.type === EventType.DIALOG_OPENED);
    expect(dialog, 'a swallowed dialog the agent cannot see is a new silent failure').toBeDefined();
    expect(dialog?.data['kind']).toBe('confirm');
    expect(dialog?.data['message']).toBe('Delete this item?');
    expect(dialog?.data['answered']).toBe(false);
  });

  it('leaves a dialog the PERSON opened completely alone', () => {
    // Not our dispatch, not our business: the human can see it and click it, and answering it for
    // them would change how their own app behaves while they are using it.
    let nativeCalled = false;
    slots.confirm = (): boolean => {
      nativeCalled = true;
      return true;
    };
    const { emit, events } = collect();
    teardown = installDialogs(emit);
    expect(window.confirm('Really?')).toBe(true);
    expect(nativeCalled, 'the page’s own confirm must still run').toBe(true);
    expect(events.filter((e) => e.type === EventType.DIALOG_OPENED)).toHaveLength(0);
  });

  it('answers prompt with null and alert with undefined', () => {
    const { emit, events } = collect();
    teardown = installDialogs(emit);
    expect(asSyntheticInput(() => window.prompt('Name?'))).toBeNull();
    expect(asSyntheticInput(() => window.alert('Saved'))).toBeUndefined();
    const kinds = events
      .filter((e) => e.type === EventType.DIALOG_OPENED)
      .map((e) => e.data['kind']);
    expect(kinds).toEqual(['prompt', 'alert']);
  });

  it('restores the page’s own functions on teardown', () => {
    const mine = (): boolean => true;
    slots.confirm = mine;
    installDialogs(collect().emit)();
    expect(slots.confirm).toBe(mine);
  });

  it('does not clobber a logging SDK that wrapped confirm after us', () => {
    // Same rule installConsole follows: restore only if the slot still holds OUR wrapper.
    const { emit } = collect();
    const t = installDialogs(emit);
    const laterWrapper = (): boolean => true;
    slots.confirm = laterWrapper;
    t();
    expect(slots.confirm).toBe(laterWrapper);
  });
});
