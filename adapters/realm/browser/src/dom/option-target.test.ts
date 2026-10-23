/**
 * A custom select (Radix and the same shape elsewhere) keeps a native `<option>` for form
 * submission and paints the choice the user actually clicks in a portal. Both answer to
 * role=option and the same accessible name. Replay resolved the native node — first in the
 * document, visually hidden — dispatched a click, and reported success while the selected
 * value stayed put. The visible portal option is the one a click changes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ActionType, QueryBy } from '@reticlehq/core';
import { executeAction } from '@/actions/actions.js';
import { refs } from './addressing/refs.js';
import { isVisible } from './visibility.js';
import { runQuery } from './query.js';

const APPLE = 'Apple';
const APPLE_VALUE = 'apple';
const NATIVE_CLICK_VALUE = 'hidden-native';
const OPTION_ROLE = 'option';
const SELECT_ID = 'native-select';
const PORTAL_ID = 'portal-apple';
const VISUALLY_HIDDEN_PX = 1;
const VISIBLE_SELECT_WIDTH = 200;
const VISIBLE_SELECT_HEIGHT = 32;

function box(el: Element, width: number, height: number): void {
  const rect = new DOMRect(0, 0, width, height);
  el.getBoundingClientRect = () => rect;
}

function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (null === el) {
    throw new Error(`fixture missing #${id}`);
  }
  return el;
}

/**
 * The Radix bubble: a 1×1 clipped `<select>` plus a portal `role=option` that is what a user
 * clicks. A select the user can see gets the same duplicate without the clip.
 */
function mountDuplicate(selectWidth: number, selectHeight: number): HTMLSelectElement {
  document.body.innerHTML = '';
  const select = document.createElement('select');
  select.id = SELECT_ID;
  select.style.position = 'absolute';
  select.style.width = `${String(selectWidth)}px`;
  select.style.height = `${String(selectHeight)}px`;
  if (selectWidth <= VISUALLY_HIDDEN_PX && selectHeight <= VISUALLY_HIDDEN_PX) {
    select.style.overflow = 'hidden';
    select.style.clip = 'rect(0, 0, 0, 0)';
  }
  const pear = document.createElement('option');
  pear.value = 'pear';
  pear.textContent = 'Pear';
  const apple = document.createElement('option');
  apple.value = APPLE_VALUE;
  apple.textContent = APPLE;
  select.append(pear, apple);
  const portal = document.createElement('div');
  portal.id = PORTAL_ID;
  portal.setAttribute('role', OPTION_ROLE);
  portal.textContent = APPLE;
  document.body.append(select, portal);
  box(select, selectWidth, selectHeight);
  box(apple, 0, 0);
  box(portal, 160, 32);
  apple.addEventListener('click', () => {
    select.value = NATIVE_CLICK_VALUE;
  });
  portal.addEventListener('click', () => {
    select.value = APPLE_VALUE;
  });
  return select;
}

function appleQuery(): ReturnType<typeof runQuery> {
  return runQuery({ by: QueryBy.ROLE, value: OPTION_ROLE, name: APPLE });
}

function nativeApple(select: HTMLSelectElement): HTMLOptionElement {
  const option = [...select.options].find((item) => item.value === APPLE_VALUE);
  if (option === undefined) {
    throw new Error('fixture missing native option');
  }
  return option;
}

describe('a role query for an option prefers the visible actionable one', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves the visible portal option, and clicking it changes the selected value', async () => {
    const select = mountDuplicate(VISUALLY_HIDDEN_PX, VISUALLY_HIDDEN_PX);
    const portal = requireElement(PORTAL_ID);
    const native = nativeApple(select);
    // The sr-only clip hides the bubble from the visibility walk; only the portal is on screen.
    expect(isVisible(select)).toBe(false);
    expect(isVisible(native)).toBe(false);
    expect(isVisible(portal)).toBe(true);

    const found = appleQuery();
    expect(found.count).toBe(1);
    expect(found.elements[0]?.ref).toBe(refs.refFor(portal));

    const ref = found.elements[0]?.ref;
    if (ref === undefined) {
      throw new Error('resolved option has no ref');
    }
    await executeAction(ref, ActionType.CLICK);
    expect(select.value).toBe(APPLE_VALUE);
  });

  it('drops an aria-hidden native option when the portal option is the one on screen', async () => {
    const select = mountDuplicate(VISIBLE_SELECT_WIDTH, VISIBLE_SELECT_HEIGHT);
    select.setAttribute('aria-hidden', 'true');
    const found = appleQuery();
    expect(found.count).toBe(1);
    expect(found.elements[0]?.ref).toBe(refs.refFor(requireElement(PORTAL_ID)));
    const ref = found.elements[0]?.ref;
    if (ref === undefined) {
      throw new Error('resolved option has no ref');
    }
    await executeAction(ref, ActionType.CLICK);
    expect(select.value).toBe(APPLE_VALUE);
  });

  it('refuses a hidden native option when it is the only match', async () => {
    const select = document.createElement('select');
    select.id = SELECT_ID;
    const apple = document.createElement('option');
    apple.value = APPLE_VALUE;
    apple.textContent = APPLE;
    select.append(apple);
    document.body.append(select);
    box(select, VISUALLY_HIDDEN_PX, VISUALLY_HIDDEN_PX);
    apple.addEventListener('click', () => {
      select.value = NATIVE_CLICK_VALUE;
    });
    const found = appleQuery();
    expect(found.count).toBe(0);
    await expect(executeAction(refs.refFor(apple), ActionType.CLICK)).rejects.toThrow(
      /visually-hidden/,
    );
    expect(select.value).not.toBe(NATIVE_CLICK_VALUE);
  });

  it('does not drop options of a select the user can see', () => {
    const select = mountDuplicate(VISIBLE_SELECT_WIDTH, VISIBLE_SELECT_HEIGHT);
    const found = appleQuery();
    expect(found.count).toBe(2);
    const refsFound = found.elements.map((el) => el.ref);
    expect(refsFound).toContain(refs.refFor(nativeApple(select)));
    expect(refsFound).toContain(refs.refFor(requireElement(PORTAL_ID)));
  });

  it('keeps a closed native select with no measured box as a real match', () => {
    document.body.innerHTML = `<select id="${SELECT_ID}"><option>${APPLE}</option></select>`;
    expect(appleQuery().count).toBe(1);
  });

  it('still reports two visible portal options as ambiguous', () => {
    document.body.innerHTML =
      '<div role="option" id="a">Apple</div><div role="option" id="b">Apple</div>';
    const found = appleQuery();
    expect(found.count).toBe(2);
  });
});
