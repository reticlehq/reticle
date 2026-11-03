/**
 * The `type`/`value` spelling mix-up: `reticle_act` documents `{ text }` for type and `{ value }`
 * for fill/select, and agents write the wrong one (reticlehq/reticle#2126, second item). The
 * normalization maps a string `value` onto `text` for the `type` action, in the flat args and in
 * the nested `args` object, and leaves every other action untouched.
 */

import { describe, expect, it } from 'vitest';

import { normalizeTypeSpelling } from './type-spelling.js';

describe('normalizeTypeSpelling', () => {
  it('maps a flat string value to text for the type action', () => {
    const out = normalizeTypeSpelling({ ref: 'r1', action: 'type', value: 'hello' });
    expect(out).toEqual({ ref: 'r1', action: 'type', text: 'hello' });
  });

  it('maps a value nested inside args for the type action', () => {
    const out = normalizeTypeSpelling({
      ref: 'r1',
      action: 'type',
      args: { text: 'hello' },
    });
    expect(out).toEqual({ ref: 'r1', action: 'type', args: { text: 'hello' } });
  });

  it('keeps a non-string value alone so the browser refusal stays accurate', () => {
    const out = normalizeTypeSpelling({ ref: 'r1', action: 'type', value: 42 });
    expect(out).toEqual({ ref: 'r1', action: 'type', value: 42 });
  });

  it('keeps value when text is already set', () => {
    const out = normalizeTypeSpelling({
      ref: 'r1',
      action: 'type',
      text: 'explicit',
      value: 'fallback',
    });
    expect(out).toEqual({ ref: 'r1', action: 'type', text: 'explicit', value: 'fallback' });
  });

  it('leaves other actions untouched', () => {
    const step = { ref: 'r1', action: 'fill', value: 'hello' };
    expect(normalizeTypeSpelling(step)).toEqual(step);
  });
});
