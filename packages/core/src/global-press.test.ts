import { describe, expect, it } from 'vitest';
import { ActionType } from './constants.js';
import { isGlobalPress, isGlobalPressCall, pressKeyFromArgs } from './global-press.js';

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
    expect(isGlobalPressCall({ action: ActionType.CLICK })).toBe(false);
    expect(
      isGlobalPressCall({ action: ActionType.CLICK, args: { text: 'Escape' } }),
      'a click is never a document key, even if someone stuffed press args on it',
    ).toBe(false);
  });
});
