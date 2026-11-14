/**
 * An element that CSS fades to almost no opacity is not shown.
 *
 * A crossfade ends at `opacity: 0`, and a frame earlier it sits at a value too small to see. The
 * composed opacity of the element and its ancestors decides, because two faint layers multiply.
 * `visible` read such an element as shown, so no check could prove that it went away.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ElementState } from '@reticlehq/core';
import { isVisible, FAINT_OPACITY } from './visibility.js';
import { matchQuery } from './query.js';

afterEach(() => {
  document.body.innerHTML = '';
});

const SAVED = { text: 'Saved' };

function shown(html: string): boolean {
  document.body.innerHTML = html;
  const target = document.querySelector('p');
  return null !== target && isVisible(target);
}

describe('composed opacity and visibility', () => {
  it('reads an element at a faint opacity as not visible', () => {
    expect(shown('<p style="opacity: 0.01">Saved</p>')).toBe(false);
  });

  it('reads two faint layers as not visible', () => {
    expect(shown('<div style="opacity: 0.2"><p style="opacity: 0.2">Saved</p></div>')).toBe(false);
  });

  it('reads a faint ancestor as not visible', () => {
    expect(shown('<div style="opacity: 0.01"><p>Saved</p></div>')).toBe(false);
  });

  it('keeps a half-faded element visible', () => {
    expect(shown('<p style="opacity: 0.5">Saved</p>')).toBe(true);
  });

  it('keeps an element at the faint limit visible', () => {
    expect(shown(`<p style="opacity: ${String(FAINT_OPACITY)}">Saved</p>`)).toBe(true);
  });

  it('matches a faded element in state hidden and not in state visible', () => {
    document.body.innerHTML = '<p style="opacity: 0.01">Saved</p>';
    expect(matchQuery(SAVED, ElementState.VISIBLE).matched).toBe(false);
    expect(matchQuery(SAVED, ElementState.HIDDEN).matched).toBe(true);
  });
});
