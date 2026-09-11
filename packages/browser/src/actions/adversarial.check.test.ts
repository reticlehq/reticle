import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '../dom/refs.js';

/**
 * The two claims the check/uncheck path rests on, pinned because both were once believed backwards.
 *
 * A proposed fix for the no-op false green set the checked property and fired `input`/`change` so a
 * framework tracker would notice. It fixed the desync and introduced a worse fault: an app that
 * autosaves, logs or POSTs on change now acts on an action that changed nothing. Caught by the first
 * test here, which is why the no-op branch dispatches nothing and reports `alreadyAtValue` instead.
 *
 * The second test settles the opposite question. The code this replaced insisted `dispatchEvent` does
 * not run activation behaviour, and used `el.click()` for that reason. It does run it — so cancellation
 * can be read off the event object, which survives a handler calling `stopPropagation()` where the old
 * window-level probe did not.
 */
function box(props: Partial<HTMLInputElement> = {}): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'checkbox';
  Object.assign(el, props);
  document.body.appendChild(el);
  return el;
}

describe('a no-op check must not fire an event no user produced', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('an app that autosaves on change does not save when nothing changed', async () => {
    const el = box({ checked: true });
    const save = vi.fn();
    el.addEventListener('change', save);

    await executeAction(refs.refFor(el), ActionType.CHECK, {});

    expect(el.checked).toBe(true);
    expect(save, 'a no-op check must not trigger the app’s change handler').not.toHaveBeenCalled();
  });

  it('a plain DOM listener sees no input event when the state did not move', async () => {
    // Framework-free on purpose: React's value tracker dedups a same-value write, so a React app can
    // hide this. A Vue, Svelte or vanilla listener cannot, and neither can an analytics hook.
    const el = box({ checked: true });
    const onInput = vi.fn();
    el.addEventListener('input', onInput);

    await executeAction(refs.refFor(el), ActionType.CHECK, {});

    expect(onInput).not.toHaveBeenCalled();
  });
});

describe('activation behaviour', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('a synthetic MouseEvent click toggles a checkbox', () => {
    const el = box({ checked: false });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    expect(el.checked, 'if this is false, dispatchEvent does NOT run activation behaviour').toBe(
      true,
    );
  });
});
