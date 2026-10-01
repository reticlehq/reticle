import { describe, expect, it } from 'vitest';
import { ActionType, InputModeReason, MAX_HOLD_MS } from '@reticlehq/core';
import type { Page } from 'playwright';
import {
  isPointerAction,
  isRealInputAction,
  performGesture,
  unspellablePressReason,
} from './real-input.js';

/**
 * `press` through real input. A synthetic KeyboardEvent does not move focus, so Tab order is only
 * verifiable with a real keyboard — and a key press needs no coordinates.
 */

/**
 * Records each keyboard call and ignores the mouse entirely.
 *
 * `press` and `down`/`up` are recorded SEPARATELY because a hold is not a press: a bare
 * `keyboard.press` cannot hold a key, so a test that only watched `pressed` would pass against an
 * implementation that dropped `holdMs` — which is exactly how the gap got in.
 */
function keyboardPage(): { page: Page; pressed: string[]; held: string[] } {
  const pressed: string[] = [];
  const held: string[] = [];
  const page = {
    keyboard: {
      press: (key: string) => {
        pressed.push(key);
        return Promise.resolve();
      },
      down: (key: string) => {
        held.push(`down:${key}`);
        return Promise.resolve();
      },
      up: (key: string) => {
        held.push(`up:${key}`);
        return Promise.resolve();
      },
    },
    mouse: {
      move: () => Promise.reject(new Error('press must not drive the mouse')),
      click: () => Promise.reject(new Error('press must not drive the mouse')),
      dblclick: () => Promise.reject(new Error('press must not drive the mouse')),
      down: () => Promise.reject(new Error('press must not drive the mouse')),
      up: () => Promise.reject(new Error('press must not drive the mouse')),
    },
  } as unknown as Page;
  return { page, pressed, held };
}

const NO_BOX = { x: 0, y: 0, width: 0, height: 0 };
const noSleep = (): Promise<void> => Promise.resolve();

describe('isRealInputAction', () => {
  it('includes every pointer action', () => {
    for (const action of [
      ActionType.HOVER,
      ActionType.CLICK,
      ActionType.DBLCLICK,
      ActionType.DRAG,
    ]) {
      expect(isRealInputAction(action)).toBe(true);
    }
  });

  it('includes press, which needs no coordinates but does need a real keyboard', () => {
    expect(isRealInputAction(ActionType.PRESS)).toBe(true);
    // The pointer predicate stays narrow: widening it would change what every caller means by it.
    expect(isPointerAction(ActionType.PRESS)).toBe(false);
  });

  it('excludes value actions that have no real-input path at all', () => {
    for (const action of [
      ActionType.FILL,
      ActionType.TYPE,
      ActionType.FOCUS,
      ActionType.BLUR,
      ActionType.CHECK,
      ActionType.UNCHECK,
      ActionType.SELECT,
      ActionType.SUBMIT,
      ActionType.SCROLL_INTO_VIEW,
    ]) {
      expect(isRealInputAction(action)).toBe(false);
    }
  });
});

describe('performGesture drives press through the real keyboard', () => {
  it('sends a plain key with page.keyboard.press', async () => {
    const { page, pressed } = keyboardPage();
    const result = await performGesture(page, ActionType.PRESS, NO_BOX, { key: 'Tab' }, noSleep);
    expect(pressed).toEqual(['Tab']);
    expect(result.performed).toBe(true);
  });

  it('reports inputMode so a verdict can say which path ran', async () => {
    const { page } = keyboardPage();
    const result = await performGesture(page, ActionType.PRESS, NO_BOX, { key: 'Tab' }, noSleep);
    expect(result.inputMode).toBe('real');
  });

  it('reports NO center — a key addresses focus, not a point on screen', async () => {
    const { page } = keyboardPage();
    const result = await performGesture(page, ActionType.PRESS, NO_BOX, { key: 'Tab' }, noSleep);
    // The signature demands a box, so the placeholder's zero reaches here. Publishing it would put
    // a real-looking (0,0) on a gesture that happened wherever focus was.
    expect(result.center).toBeUndefined();
  });

  it('expresses modifiers the way Playwright spells them', async () => {
    const { page, pressed } = keyboardPage();
    await performGesture(
      page,
      ActionType.PRESS,
      NO_BOX,
      { key: 'k', modifiers: ['Meta'] },
      noSleep,
    );
    expect(pressed).toEqual(['Meta+k']);
  });

  it('normalises modifier aliases to Playwright names', async () => {
    const { page, pressed } = keyboardPage();
    await performGesture(page, ActionType.PRESS, NO_BOX, { key: 'k', modifiers: ['cmd'] }, noSleep);
    expect(pressed).toEqual(['Meta+k']);
  });

  it('drops a modifier the driver cannot spell, rather than pressing it literally', async () => {
    const { page, pressed } = keyboardPage();
    await performGesture(
      page,
      ActionType.PRESS,
      NO_BOX,
      { key: 'k', modifiers: ['Hyper'] },
      noSleep,
    );
    // `Hyper+k` is not a key name Playwright knows; it would be passed through as a literal.
    expect(pressed).toEqual(['k']);
  });

  it('defaults to Enter when no key was named, matching the synthetic path', async () => {
    const { page, pressed } = keyboardPage();
    await performGesture(page, ActionType.PRESS, NO_BOX, {}, noSleep);
    expect(pressed).toEqual(['Enter']);
  });

  it('falls back to Enter on an empty key, exactly like the synthetic path', async () => {
    const { page, pressed } = keyboardPage();
    const result = await performGesture(page, ActionType.PRESS, NO_BOX, { key: '' }, noSleep);
    expect(pressed).toEqual(['Enter']);
    expect(result.performed).toBe(true);
  });

  it('holds a key for holdMs instead of tapping it', async () => {
    const { page, pressed, held } = keyboardPage();
    const slept: number[] = [];
    const result = await performGesture(
      page,
      ActionType.PRESS,
      NO_BOX,
      { key: 'Space', holdMs: 1200 },
      (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    );

    // Down, wait, up — the shape the page uses for a held key. `pressed` must stay empty: a bare
    // `keyboard.press` would report a hold-to-confirm that released immediately.
    expect(held).toEqual(['down:Space', 'up:Space']);
    expect(pressed).toEqual([]);
    expect(slept).toEqual([1200]);
    expect(result.performed).toBe(true);
  });

  it('caps an unbounded hold at the shared maximum, like the synthetic path', async () => {
    const { page, held } = keyboardPage();
    const slept: number[] = [];
    await performGesture(
      page,
      ActionType.PRESS,
      NO_BOX,
      { key: 'Space', holdMs: 10_000_000 },
      (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    );

    expect(slept).toEqual([MAX_HOLD_MS]);
    expect(held).toEqual(['down:Space', 'up:Space']);
  });

  it('still taps when holdMs is absent, zero, or not a number', async () => {
    // `unknown` on purpose: the last case is a caller sending a string where a number belongs,
    // and it must reach the clamp rather than being refused by the compiler first.
    const cases: Record<string, unknown>[] = [
      { key: 'Tab' },
      { key: 'Tab', holdMs: 0 },
      { key: 'Tab', holdMs: 'x' },
    ];
    for (const args of cases) {
      const { page, pressed, held } = keyboardPage();
      await performGesture(page, ActionType.PRESS, NO_BOX, args, noSleep);
      expect(pressed, `args ${JSON.stringify(args)}`).toEqual(['Tab']);
      expect(held, `args ${JSON.stringify(args)}`).toEqual([]);
    }
  });

  it('holds the whole chord, modifiers included', async () => {
    // `down`/`up` take ONE key each — `down('Meta+k')` throws `Unknown key: "Meta+k"`, measured on
    // a real Chromium. So a held chord is split: modifiers down in chord order, the key last, and
    // released key-first with the modifiers reversed, which is what a hand does.
    const { page, held } = keyboardPage();
    await performGesture(
      page,
      ActionType.PRESS,
      NO_BOX,
      { key: 'k', modifiers: ['Meta'], holdMs: 50 },
      noSleep,
    );
    expect(held).toEqual(['down:Meta', 'down:k', 'up:k', 'up:Meta']);
  });

  it('splits a two-modifier hold in press order and releases it in reverse', async () => {
    const { page, held } = keyboardPage();
    await performGesture(
      page,
      ActionType.PRESS,
      NO_BOX,
      { key: 'k', modifiers: ['Control', 'Shift'], holdMs: 50 },
      noSleep,
    );
    // Chord order is the canonical Meta/Control/Shift/Alt sequence core produces, not the order the
    // caller typed them — that normalisation is `pressModifiersFromArgs`' job and is asserted there.
    expect(held).toEqual([
      'down:Control',
      'down:Shift',
      'down:k',
      'up:k',
      'up:Shift',
      'up:Control',
    ]);
  });

  it('never sends a chord string to down/up, which would throw before a key moved', async () => {
    // The whole point of the split. A real Page rejects `down('Meta+k')` outright, so any test that
    // only recorded the string would pass while the gesture died on the first call.
    const sent: string[] = [];
    const page = {
      keyboard: {
        press: (key: string) => {
          sent.push(`press:${key}`);
          return Promise.resolve();
        },
        down: (key: string) => {
          if (key.includes('+')) return Promise.reject(new Error(`Unknown key: "${key}"`));
          sent.push(`down:${key}`);
          return Promise.resolve();
        },
        up: (key: string) => {
          if (key.includes('+')) return Promise.reject(new Error(`Unknown key: "${key}"`));
          sent.push(`up:${key}`);
          return Promise.resolve();
        },
      },
    } as unknown as Page;

    const result = await performGesture(
      page,
      ActionType.PRESS,
      NO_BOX,
      { key: 'k', modifiers: ['Meta'], holdMs: 50 },
      noSleep,
    );

    expect(result.performed).toBe(true);
    expect(sent).toEqual(['down:Meta', 'down:k', 'up:k', 'up:Meta']);
  });

  it('reports the hold it actually achieved, not the number it was asked for', async () => {
    const { page } = keyboardPage();
    // An injected clock, so the assertion is about the measurement rather than about how long the
    // machine took: the wait overshoots on a throttled tab, and a caller needs to tell "held 1200"
    // from "held 1204". The test advances the clock itself rather than racing a real timer.
    let t = 1_000;
    const result = await performGesture(
      page,
      ActionType.PRESS,
      NO_BOX,
      { key: 'Space', holdMs: 1200 },
      () => {
        t += 1204; // the achieved hold, which is what must be reported
        return Promise.resolve();
      },
      () => t,
    );

    expect(result.heldMs).toBe(1204);
  });

  it('omits heldMs entirely when there was no hold to measure', async () => {
    const { page } = keyboardPage();
    const result = await performGesture(page, ActionType.PRESS, NO_BOX, { key: 'Tab' }, noSleep);
    // Absent, not 0: an absent key says "this action does not hold", where a 0 reads as "it held
    // for no time" — the same rule the synthetic path's effect block uses.
    expect('heldMs' in result).toBe(false);
  });

  it('releases the key when the wait fails, so it cannot stay held', async () => {
    // #1295. The caller catches the throw and runs the SYNTHETIC path, which presses this same key
    // again — so a driver copy left down colours every later action for the rest of the run.
    const { page, held } = keyboardPage();
    const boom = new Error('the page went away mid-hold');

    await expect(
      performGesture(page, ActionType.PRESS, NO_BOX, { key: 'Control', holdMs: 1200 }, () =>
        Promise.reject(boom),
      ),
    ).rejects.toBe(boom);

    expect(held).toEqual(['down:Control', 'up:Control']);
  });

  it('still reports a failed RELEASE on the ordinary path, rather than swallowing it', async () => {
    // The mirror of the test above: releasing best-effort is for the failure path only. A press
    // whose key is still down must not report success — and it must be distinguishable from an
    // ordinary drive failure, because the caller answers the two differently.
    const page = {
      keyboard: {
        press: () => Promise.resolve(),
        down: () => Promise.resolve(),
        up: () => Promise.reject(new Error('release failed')),
      },
    } as unknown as Page;
    await expect(
      performGesture(page, ActionType.PRESS, NO_BOX, { key: 'Space', holdMs: 50 }, noSleep),
    ).rejects.toThrow('release failed');
    await expect(
      performGesture(page, ActionType.PRESS, NO_BOX, { key: 'Space', holdMs: 50 }, noSleep),
    ).rejects.toMatchObject({ code: 'release_failed' });
  });

  it('releases the remaining keys even after the first release fails', async () => {
    // A stuck `Control` is worse than a stuck letter, so a failure on the key must not skip the
    // modifiers. Every release is attempted; the first failure is the one reported.
    const released: string[] = [];
    const page = {
      keyboard: {
        press: () => Promise.resolve(),
        down: () => Promise.resolve(),
        up: (key: string) => {
          released.push(key);
          return 'k' === key ? Promise.reject(new Error('release failed')) : Promise.resolve();
        },
      },
    } as unknown as Page;

    await expect(
      performGesture(
        page,
        ActionType.PRESS,
        NO_BOX,
        { key: 'k', modifiers: ['Control'], holdMs: 50 },
        noSleep,
      ),
    ).rejects.toMatchObject({ code: 'release_failed' });

    expect(released).toEqual(['k', 'Control']);
  });

  it('keeps mouse actions reporting real mode too, so the field is not press-only', async () => {
    const moves: string[] = [];
    const page = {
      mouse: {
        move: (x: number, y: number) => {
          moves.push(`${String(x)},${String(y)}`);
          return Promise.resolve();
        },
      },
    } as unknown as Page;
    const result = await performGesture(
      page,
      ActionType.HOVER,
      { x: 10, y: 20, width: 100, height: 40 },
      {},
      noSleep,
    );
    expect(result.inputMode).toBe('real');
    expect(moves.length).toBeGreaterThan(0);
    expect(result.center).toEqual({ cx: 60, cy: 40 });
  });
});

describe('unspellablePressReason — which presses the real keyboard must not be handed', () => {
  it('routes a multi-key sequence away, naming the reason', () => {
    // `Control+k` as a chord means "Control held while k is struck"; `keys: ['Control','k']` means
    // "Control down, then k down, then both up in reverse". Playwright's press takes the first and
    // has no spelling for the second, so a driver handed it would send a gesture nobody asked for.
    expect(unspellablePressReason('', { keys: ['Control', 'k'] })).toBe(
      InputModeReason.SYNTHETIC_MULTI_KEY_PRESS_PREFERRED,
    );
  });

  it('routes a press that named an element away too', () => {
    expect(unspellablePressReason('e1', { text: 'Enter' })).toBe(
      InputModeReason.SYNTHETIC_ELEMENT_PRESS_PREFERRED,
    );
  });

  it('routes an explicit physical code away, which the driver cannot send', () => {
    // `{ text: 'z', code: 'KeyY' }` is a caller on a non-US layout saying the physical key differs
    // from the logical one. `page.keyboard.press` presses by KEY name, so the driver would strike
    // 'z' — a different key than the one asked for, reported as the one asked for.
    expect(unspellablePressReason('', { text: 'z', code: 'KeyY' })).toBe(
      InputModeReason.SYNTHETIC_KEY_CODE_PRESS_PREFERRED,
    );
  });

  it('names the key-naming cases before the ref case, however many apply', () => {
    // Each of these names the KEY; `ref` names only the target. The reason should say which of the
    // two key-level requests was made, because "you passed a ref" hides the one that mattered.
    expect(unspellablePressReason('e1', { text: 'z', code: 'KeyY' })).toBe(
      InputModeReason.SYNTHETIC_KEY_CODE_PRESS_PREFERRED,
    );
    expect(unspellablePressReason('e1', { keys: ['Control', 'k'], code: 'KeyY' })).toBe(
      InputModeReason.SYNTHETIC_MULTI_KEY_PRESS_PREFERRED,
    );
  });

  it('leaves the document key a real keyboard IS for alone', () => {
    expect(unspellablePressReason('', { text: 'Tab' })).toBeUndefined();
    expect(unspellablePressReason('', { text: 'k', modifiers: ['Meta'] })).toBeUndefined();
  });

  it('names the multi-key case first when both apply — it is the one the caller asked for', () => {
    expect(unspellablePressReason('e1', { keys: ['Control', 'k'] })).toBe(
      InputModeReason.SYNTHETIC_MULTI_KEY_PRESS_PREFERRED,
    );
  });
});
