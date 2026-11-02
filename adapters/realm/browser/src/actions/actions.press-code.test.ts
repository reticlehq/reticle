/**
 * A synthetic key press has to carry `code`, not only `key`.
 *
 * Reported by an agent whose keyboard fallback was unavailable: dnd-kit's `KeyboardSensor` matches
 * both its activation key and its arrow keys on `event.code`, so a press that sets only `key` can
 * neither start nor steer a keyboard drag. react-aria and anything keyed on PHYSICAL keys behave
 * the same way — `code` is the layout-independent identity of the key, and it is what a real
 * browser always sends.
 *
 * The failure is silent in the worst way: the event fires, the handler runs, and the guard simply
 * does not match — so the action reports dispatched and nothing happens.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

let el: HTMLButtonElement;
let seen: KeyboardEvent[];

beforeEach(() => {
  document.body.innerHTML = '';
  el = document.createElement('button');
  document.body.append(el);
  seen = [];
  for (const type of ['keydown', 'keyup']) {
    el.addEventListener(type, (event) => seen.push(event as KeyboardEvent));
  }
});

const press = async (args: Record<string, unknown>): Promise<void> => {
  await executeAction(refs.refFor(el), ActionType.PRESS, args);
};

describe('press carries a physical key code', () => {
  it('derives `code` for a letter', async () => {
    await press({ key: 'a' });
    expect(seen[0]?.key).toBe('a');
    expect(seen[0]?.code).toBe('KeyA');
  });

  it('derives `code` for a digit', async () => {
    await press({ key: '7' });
    expect(seen[0]?.code).toBe('Digit7');
  });

  it('passes named keys through unchanged — they are already codes', async () => {
    for (const key of ['Enter', 'Escape', 'Tab', 'ArrowDown']) {
      seen = [];
      await press({ key });
      expect(seen[0]?.code, key).toBe(key);
    }
  });

  it('names the space bar the way the spec does', async () => {
    await press({ key: ' ' });
    expect(seen[0]?.code).toBe('Space');
  });

  it('lets an explicit `code` win over the derived one', async () => {
    // A caller driving a non-US layout knows better than the derivation does.
    await press({ key: 'q', code: 'KeyA' });
    expect(seen[0]?.code).toBe('KeyA');
  });

  it('sets it on keyup too, so a held-key handler sees a matching pair', async () => {
    await press({ key: 'ArrowRight' });
    expect(seen.map((e) => e.type)).toEqual(['keydown', 'keyup']);
    expect(seen[1]?.code).toBe('ArrowRight');
  });

  it('leaves `code` empty rather than guessing at a multi-character mystery', async () => {
    await press({ key: 'Zzz' });
    expect(seen[0]?.code).toBe('');
  });
});

/**
 * #2139: an app opens help on `Mod+/` and matches `event.code === 'Slash'`. `press { key: "Meta+/" }`
 * dispatched ONE keydown whose key was the literal string "Meta+/", with no meta flag and no code, and
 * reported dispatched; the dialog never opened on a correct build. A chord is split the way
 * Playwright spells it, and punctuation carries the code a US-layout keyboard sends.
 */
describe('press reads a chord and the code of punctuation', () => {
  it('splits a chord into its modifier flags and its key', async () => {
    await press({ key: 'Meta+/' });
    expect(seen[0]).toMatchObject({ key: '/', code: 'Slash', metaKey: true, ctrlKey: false });
  });

  it('accepts several modifiers and the aliases a person writes', async () => {
    await press({ key: 'Ctrl+Shift+k' });
    expect(seen[0]).toMatchObject({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true });
  });

  it('accepts a key named by its code', async () => {
    await press({ key: 'Meta+Slash' });
    expect(seen[0]).toMatchObject({ key: '/', code: 'Slash', metaKey: true });
  });

  it('gives punctuation and its shifted character the US-layout code', async () => {
    const codes: Record<string, string> = {
      '/': 'Slash',
      '?': 'Slash',
      '.': 'Period',
      ',': 'Comma',
      '[': 'BracketLeft',
      '-': 'Minus',
      '!': 'Digit1',
    };
    for (const [key, code] of Object.entries(codes)) {
      seen = [];
      await press({ key });
      expect(seen[0]?.code, key).toBe(code);
    }
  });

  it('presses a plus sign, alone or as the key of a chord', async () => {
    await press({ key: '+' });
    expect(seen[0]).toMatchObject({ key: '+', metaKey: false });
    seen = [];
    await press({ key: 'Control++' });
    expect(seen[0]).toMatchObject({ key: '+', ctrlKey: true });
  });

  it('leaves a word with a plus that is not a chord as it is', async () => {
    await press({ key: 'Foo+x' });
    expect(seen[0]?.key).toBe('Foo+x');
  });
});
