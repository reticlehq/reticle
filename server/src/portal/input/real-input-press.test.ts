import { describe, expect, it } from 'vitest';
import { ActionType, InputModeReason } from '@reticlehq/core';
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
 * A `down`/`up` pair is a REFUSAL, not a recording: this path presses a chord and releases it, so an
 * implementation that reached for the held-key API would be doing something the caller did not ask
 * for. Rejecting is how that shows up as a failure rather than as silence.
 */
function keyboardPage(): { page: Page; pressed: string[] } {
  const pressed: string[] = [];
  const page = {
    keyboard: {
      press: (key: string) => {
        pressed.push(key);
        return Promise.resolve();
      },
      down: () => Promise.reject(new Error('a press is not a hold')),
      up: () => Promise.reject(new Error('a press is not a hold')),
    },
    mouse: {
      move: () => Promise.reject(new Error('press must not drive the mouse')),
      click: () => Promise.reject(new Error('press must not drive the mouse')),
      dblclick: () => Promise.reject(new Error('press must not drive the mouse')),
      down: () => Promise.reject(new Error('press must not drive the mouse')),
      up: () => Promise.reject(new Error('press must not drive the mouse')),
    },
  } as unknown as Page;
  return { page, pressed };
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
