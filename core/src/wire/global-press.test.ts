import { describe, expect, it } from 'vitest';
import { ActionType } from './constants/constants.js';
import {
  isGlobalPress,
  isGlobalPressCall,
  pressKeyFromArgs,
  pressKeysFromArgs,
} from './global-press.js';

/**
 * Escape, Tab, and a modifier shortcut are document keys — they are not addressed to an element.
 * A press that IS aimed at a control (Enter on a button, typing a letter into a field) still
 * needs a ref. These cases are the contract both the server locator and the in-page dispatcher
 * must honour, so the helper lives in core rather than being restated on each side.
 */
describe('which press is a document key', () => {
  it('Escape is global, whether named as text or key', () => {
    expect(isGlobalPress({ text: 'Escape' })).toBe(true);
    expect(isGlobalPress({ key: 'Escape' })).toBe(true);
    expect(isGlobalPress({ text: 'escape' }), 'agents send either casing').toBe(true);
  });

  it('Tab is global', () => {
    expect(isGlobalPress({ text: 'Tab' })).toBe(true);
  });

  it('a modifier shortcut is global even when the key itself is not', () => {
    expect(isGlobalPress({ text: 'k', modifiers: ['Meta'] })).toBe(true);
    expect(isGlobalPress({ key: 'k', modifiers: ['Control', 'Shift'] })).toBe(true);
  });

  it('an unrecognised modifier name still counts — it decides a ref, not a chord', () => {
    // This predicate answers "is a ref required", not "which key is pressed", so it reads the array
    // by length and never consults `pressModifiersFromArgs`'s alias table — which is dead weight in
    // the page and would otherwise ride along on every load. A name the driver cannot spell still
    // makes this a shortcut rather than a typo, and the chord is the driver's problem, not this
    // predicate's: it is only ever asked whether a locator is needed.
    expect(isGlobalPress({ text: 'k', modifiers: ['Hyper'] })).toBe(true);
    expect(isGlobalPress({ text: 'k', modifiers: ['Control', 'Bogus'] })).toBe(true);
  });

  it('several keys held together is global too — it is a sequence at the page, not at a control', () => {
    // Without this the documented `keys` spelling has no reachable path: an agent sending
    // `{ keys: ['Control','k'] }` with no ref would be refused with "pass a ref" before any router
    // could see it, and the multi-key reason below could never be reported.
    expect(isGlobalPress({ keys: ['Control', 'k'] })).toBe(true);
    expect(isGlobalPress({ keys: [] }), 'an empty list names nothing').toBe(false);
    expect(isGlobalPress({ keys: [7, null] }), 'nor does a list of unusable names').toBe(false);
  });

  it('a ONE-element `keys` answers exactly as the one-key spelling does', () => {
    // Judging the list by its LENGTH let `{ keys: ['Enter'] }` omit the ref that `{ key: 'Enter' }` is
    // refused without. Enter is the key that must never be a document key unreferenced: it lands on
    // whatever holds focus, and inside a form on a focused field that submits it.
    expect(isGlobalPress({ keys: ['Enter'] })).toBe(false);
    expect(isGlobalPress({ keys: ['a'] })).toBe(false);
    expect(isGlobalPress({ keys: ['Escape'] })).toBe(true);
    expect(isGlobalPress({ keys: ['Tab'] })).toBe(true);
    // The same answer either way, which is the invariant rather than any one of the four lines.
    for (const key of ['Enter', 'a', 'Escape', 'Tab']) {
      expect(isGlobalPress({ keys: [key] }), `${key} via keys`).toBe(isGlobalPress({ key }));
    }
  });

  it('Enter without modifiers is NOT global — it submits the focused control', () => {
    expect(isGlobalPress({ text: 'Enter' })).toBe(false);
    expect(isGlobalPress({}), 'the default key is Enter').toBe(false);
  });

  it('a letter with no modifiers is NOT global', () => {
    expect(isGlobalPress({ text: 'a' })).toBe(false);
  });

  it('an empty modifiers list is not a shortcut', () => {
    expect(isGlobalPress({ text: 'k', modifiers: [] })).toBe(false);
  });

  it('text wins over key, matching the documented press argument', () => {
    expect(pressKeyFromArgs({ text: 'Escape', key: 'Enter' })).toBe('Escape');
  });
});

describe('which tool call is a document-key press', () => {
  it('only a press of a global key, reading the nested args the tools actually send', () => {
    expect(isGlobalPressCall({ action: ActionType.PRESS, args: { text: 'Escape' } })).toBe(true);
    expect(isGlobalPressCall({ action: ActionType.PRESS, args: { text: 'Enter' } })).toBe(false);
    expect(isGlobalPressCall({ action: ActionType.PRESS, args: { keys: ['Control', 'k'] } })).toBe(
      true,
    );
    expect(isGlobalPressCall({ action: ActionType.CLICK })).toBe(false);
    expect(
      isGlobalPressCall({ action: ActionType.CLICK, args: { text: 'Escape' } }),
      'a click is never a document key, even if someone stuffed press args on it',
    ).toBe(false);
  });
});

describe('which keys a press holds down together', () => {
  it('is empty for the ordinary one-key press, so nothing about it changes', () => {
    expect(pressKeysFromArgs({})).toEqual([]);
    expect(pressKeysFromArgs({ text: 'Escape' })).toEqual([]);
    expect(pressKeysFromArgs({ modifiers: ['Meta'] })).toEqual([]);
  });

  it('reads the sequence a modifier flag cannot express', () => {
    expect(pressKeysFromArgs({ keys: ['Control', 'k'] })).toEqual(['Control', 'k']);
  });

  it('drops entries that are not usable key names, rather than pressing an empty string', () => {
    expect(pressKeysFromArgs({ keys: ['Control', '', 'k', 7, null] })).toEqual(['Control', 'k']);
    expect(pressKeysFromArgs({ keys: 'Control' }), 'a bare string is not a list').toEqual([]);
  });
});
