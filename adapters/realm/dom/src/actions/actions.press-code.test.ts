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
import { refs } from '../dom/refs.js';

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
