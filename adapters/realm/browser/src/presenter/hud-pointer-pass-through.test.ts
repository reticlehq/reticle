import { afterEach, describe, expect, it } from 'vitest';
import {
  RETICLE_CHROME_PASS_THROUGH_SCRIPT,
  RETICLE_CHROME_RESTORE_POINTER_SCRIPT,
} from '@reticlehq/core';
import { Presenter } from './presenter.js';

/**
 * A native click from Reticle landed on its own HUD (#992).
 *
 * On a lease with the HUD shown, the HUD sat over the app's bottom-right button. The daemon drove a
 * real pointer at the button's centre, the HUD control under that point took the click, and the
 * verdict said the app did nothing. A drag in the same session ended one cell short.
 *
 * The daemon runs the pass-through script in the page around each real pointer gesture. jsdom has
 * no layout, so this test plays the browser's hit test: the stack at the point is the HUD control
 * over the app button, and the pointer goes to the first one whose `pointer-events` is not `none`.
 */
const HUD_MOUNT_TIMEOUT_MS = 30_000;

afterEach(() => {
  document.querySelectorAll('[data-reticle-overlay]').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

/** Run a script string in the page, as `page.evaluate` does: as a script element, then removed. */
function runInPage(script: string): void {
  const el = document.createElement('script');
  el.textContent = script;
  document.head.appendChild(el);
  el.remove();
}

/** The element a real pointer reaches: the topmost one in the stack that takes pointer events. */
function hitTest(stack: readonly Element[]): Element | undefined {
  return stack.find((el) => 'none' !== getComputedStyle(el).pointerEvents);
}

describe('a real pointer gesture looks through the HUD', { timeout: HUD_MOUNT_TIMEOUT_MS }, () => {
  it('reaches the app button under a HUD control, and the HUD control works again after', () => {
    const app = document.createElement('button');
    app.textContent = 'Save changes';
    let appClicks = 0;
    app.addEventListener('click', () => {
      appClicks += 1;
    });
    document.body.appendChild(app);

    const presenter = new Presenter({});
    presenter.mount();
    presenter.sessionStart();
    const hudControl = document.querySelector('[data-reticle-fab]');
    expect(hudControl).not.toBeNull();
    if (null === hudControl) {
      return;
    }
    let hudClicks = 0;
    hudControl.addEventListener('click', () => {
      hudClicks += 1;
    });
    const stack = [hudControl, app];

    // Without the pass-through, the HUD control takes the pointer. This is the defect.
    expect(hitTest(stack)).toBe(hudControl);

    runInPage(RETICLE_CHROME_PASS_THROUGH_SCRIPT);
    hitTest(stack)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(appClicks).toBe(1);
    expect(hudClicks).toBe(0);

    runInPage(RETICLE_CHROME_RESTORE_POINTER_SCRIPT);
    // A person can still click the HUD control after the gesture.
    expect(hitTest(stack)).toBe(hudControl);
    expect((hudControl as HTMLElement).style.getPropertyValue('pointer-events')).toBe('');
    presenter.destroy();
  });

  it('puts back an inline pointer-events value that Reticle set itself', () => {
    const presenter = new Presenter({});
    presenter.mount();
    const overlay = document.querySelector('div[data-reticle-overlay]') as HTMLElement;
    overlay.style.setProperty('pointer-events', 'auto');
    runInPage(RETICLE_CHROME_PASS_THROUGH_SCRIPT);
    expect(overlay.style.getPropertyValue('pointer-events')).toBe('none');
    runInPage(RETICLE_CHROME_RESTORE_POINTER_SCRIPT);
    expect(overlay.style.getPropertyValue('pointer-events')).toBe('auto');
    presenter.destroy();
  });
});
