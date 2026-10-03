import { describe, expect, it, beforeEach } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

/**
 * #393: `press` synthesised a KeyboardEvent with no modifier flags, so a Cmd+K / Ctrl+Shift
 * shortcut arrived with metaKey/ctrlKey/shiftKey/altKey all false. The app's own check never
 * matched, nothing observable happened, and Reticle reported no error -- a false negative, the
 * expensive direction.
 */
describe('press sets modifier flags (#393)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('fires a metaKey+shiftKey shortcut the app only responds to with both', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    let fired = false;
    el.addEventListener('keydown', (e) => {
      if (e.metaKey && e.shiftKey) fired = true;
    });
    await executeAction(refs.refFor(el), ActionType.PRESS, {
      key: 'k',
      modifiers: ['Meta', 'Shift'],
    });
    expect(fired).toBe(true);
  });

  it('sets each flag independently and leaves the rest false', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const seen: KeyboardEvent[] = [];
    el.addEventListener('keydown', (e) => seen.push(e));
    await executeAction(refs.refFor(el), ActionType.PRESS, { key: 'a', modifiers: ['Control'] });
    expect(seen[0]?.ctrlKey).toBe(true);
    expect(seen[0]?.metaKey).toBe(false);
    expect(seen[0]?.altKey).toBe(false);
  });

  it('accepts the common aliases (Cmd, Option)', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    let ok = false;
    el.addEventListener('keydown', (e) => {
      if (e.metaKey && e.altKey) ok = true;
    });
    await executeAction(refs.refFor(el), ActionType.PRESS, {
      key: 'p',
      modifiers: ['Cmd', 'Option'],
    });
    expect(ok).toBe(true);
  });

  it('also sets the flags on keyup', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    let upMeta = false;
    el.addEventListener('keyup', (e) => {
      upMeta = e.metaKey;
    });
    await executeAction(refs.refFor(el), ActionType.PRESS, { key: 'k', modifiers: ['Meta'] });
    expect(upMeta).toBe(true);
  });

  it('with no modifiers every flag stays false (unchanged behaviour)', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    let anyMod = true;
    el.addEventListener('keydown', (e) => {
      anyMod = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    });
    await executeAction(refs.refFor(el), ActionType.PRESS, { key: 'Enter' });
    expect(anyMod).toBe(false);
  });
});

/**
 * #1294: a modifier named in `keys` did not reach the event flags.
 *
 * `modifiers` is a fixed set of flags for the whole press, which is exactly why `keys` exists — a
 * SEQUENCE whose held state changes partway through. `pressCombo` read the flags from `args.modifiers`
 * alone, so `{ keys: ['Control', 'k'] }` pressed Control and then dispatched the `k` keydown with
 * `ctrlKey: false`. A shortcut handler checking `event.ctrlKey` did nothing while the action
 * reported success.
 *
 * The expectations below are the browser's own, read off a real Chromium: a modifier's OWN keydown
 * carries its flag already true, its OWN keyup carries it already false, and every event in between
 * carries the held state as it stands at that moment.
 */
describe('a modifier named in keys sets its own flag (#1294)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** Records every keyboard event on a fresh button, as `key:flag` pairs. */
  function record(): { el: HTMLElement; seen: string[] } {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const seen: string[] = [];
    // `as const` rather than a plain array: the literal union selects the KeyboardEvent overload,
    // where a widened `string` falls back to the bare Event one and `e.key` stops existing.
    for (const type of ['keydown', 'keyup'] as const) {
      el.addEventListener(type, (e) => {
        seen.push(`${e.key} ctrl=${String(e.ctrlKey)} shift=${String(e.shiftKey)}`);
      });
    }
    return { el, seen };
  }

  it('reaches a handler that only responds to event.ctrlKey', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    let fired = false;
    el.addEventListener('keydown', (e) => {
      if ('k' === e.key && e.ctrlKey) fired = true;
    });
    await executeAction(refs.refFor(el), ActionType.PRESS, { keys: ['Control', 'k'] });
    expect(fired).toBe(true);
  });

  it('carries the held state through the sequence the way a real keyboard does', async () => {
    const { el, seen } = record();
    await executeAction(refs.refFor(el), ActionType.PRESS, { keys: ['Control', 'k'] });
    // Control's own keydown is already true; the `k` and its release inherit it; Control's own
    // keyup is already false. Anything else puts one event out by one step.
    expect(seen).toEqual([
      'Control ctrl=true shift=false',
      'k ctrl=true shift=false',
      'k ctrl=true shift=false',
      'Control ctrl=false shift=false',
    ]);
  });

  it('holds every modifier in a two-modifier sequence, in press order', async () => {
    const { el, seen } = record();
    await executeAction(refs.refFor(el), ActionType.PRESS, { keys: ['Control', 'Shift', 'k'] });
    expect(seen).toEqual([
      'Control ctrl=true shift=false',
      'Shift ctrl=true shift=true',
      'k ctrl=true shift=true',
      'k ctrl=true shift=true',
      'Shift ctrl=true shift=false',
      'Control ctrl=false shift=false',
    ]);
  });

  it('accepts the aliases in keys, so Ctrl and Cmd are not a separate vocabulary', async () => {
    const { el, seen } = record();
    await executeAction(refs.refFor(el), ActionType.PRESS, { keys: ['Ctrl', 'k'] });
    expect(seen[1]).toBe('k ctrl=true shift=false');
  });

  it('composes with args.modifiers instead of overriding it', async () => {
    const { el, seen } = record();
    await executeAction(refs.refFor(el), ActionType.PRESS, {
      modifiers: ['Shift'],
      keys: ['Control', 'k'],
    });
    // Shift is held from the start (it came from `modifiers`), Control joins at its own keydown.
    expect(seen).toEqual([
      'Control ctrl=true shift=true',
      'k ctrl=true shift=true',
      'k ctrl=true shift=true',
      'Control ctrl=false shift=true',
    ]);
  });

  it('leaves a plain multi-key sequence with every flag false', async () => {
    const { el, seen } = record();
    await executeAction(refs.refFor(el), ActionType.PRESS, { keys: ['a', 'b'] });
    expect(seen).toEqual([
      'a ctrl=false shift=false',
      'b ctrl=false shift=false',
      'b ctrl=false shift=false',
      'a ctrl=false shift=false',
    ]);
  });

  /**
   * The same modifier under two spellings is ONE key, and releasing either spelling must not clear
   * a flag the other still holds.
   *
   * `keys: ['Control', 'k', 'Ctrl']` releases in reverse, so `Ctrl` comes up first — and `Ctrl` and
   * `Control` are the same flag in `MODIFIER_FLAG_ALIASES`. Clearing it there left the `k` keyup
   * reporting `ctrlKey: false` while `Control` had not been released yet, which is a state no
   * keyboard produces and an app's keyup bookkeeping reads as "the modifier came up".
   */
  it('does not clear a modifier flag while another spelling of it is still held', async () => {
    const { el, seen } = record();
    await executeAction(refs.refFor(el), ActionType.PRESS, { keys: ['Control', 'k', 'Ctrl'] });
    // `Ctrl` and `Control` are ONE flag (`MODIFIER_FLAG_ALIASES`), pressed twice and released in
    // reverse — so `Ctrl`'s own keyup is the event that used to clear the flag while `Control` was
    // still down, leaving every event after it reporting `ctrlKey: false`. Only the LAST release of
    // a flag turns it off, which is what the `Control` keyup at the end does.
    expect(seen).toEqual([
      'Control ctrl=true shift=false',
      'k ctrl=true shift=false',
      'Ctrl ctrl=true shift=false',
      'Ctrl ctrl=true shift=false',
      'k ctrl=true shift=false',
      'Control ctrl=false shift=false',
    ]);
  });

  /**
   * A non-string entry in `keys` must be DROPPED, not dispatched and not thrown on.
   *
   * `keys` crosses the bridge as JSON, so a caller can put anything in the array — and the routing
   * half (`pressKeysFromArgs`, in core) already drops non-strings when it decides whether a ref is
   * required. If the dispatcher read the array differently it would either send a key the router
   * never counted or throw on the way, and the two halves disagreeing about the same argument is
   * the failure this pins.
   */
  it('drops a non-string entry in keys instead of throwing on it', async () => {
    const { el, seen } = record();
    const args: Record<string, unknown> = { keys: ['Control', 'k', null, 7, undefined] };
    await executeAction(refs.refFor(el), ActionType.PRESS, args);
    // The usable keys ran, in order, with the modifier held — the junk is simply not there.
    expect(seen).toEqual([
      'Control ctrl=true shift=false',
      'k ctrl=true shift=false',
      'k ctrl=true shift=false',
      'Control ctrl=false shift=false',
    ]);
  });

  /**
   * The same modifier named in BOTH spellings at once, `modifiers` and `keys`.
   *
   * `modifiers` is the fixed set that stays true for the WHOLE press — its flags are never released,
   * which the composing test above pins: Shift is still true on the very last keyup. Naming that same
   * flag in `keys` therefore has to leave it true when the `keys` release arrives, or the release
   * contradicts the argument that declared it for the whole gesture.
   *
   * Counting only the presses that came from `keys` made the first release drop the count to zero and
   * clear a flag `modifiers` still held. `{ modifiers: ['Shift'], keys: ['Shift', 'Tab'] }` ended
   * with `shiftKey: false` on Shift's own keyup — a state no keyboard produces, and the opposite of
   * what the caller asked for.
   */
  it('does not let a keys release clear a flag args.modifiers declared for the whole press', async () => {
    const { el, seen } = record();
    await executeAction(refs.refFor(el), ActionType.PRESS, {
      modifiers: ['Shift'],
      keys: ['Shift', 'Tab'],
    });
    // Shift stays true throughout, its own keyup included: `modifiers` holds it for the gesture and
    // `keys` merely names the same flag a second time.
    expect(seen).toEqual([
      'Shift ctrl=false shift=true',
      'Tab ctrl=false shift=true',
      'Tab ctrl=false shift=true',
      'Shift ctrl=false shift=true',
    ]);
  });
});
