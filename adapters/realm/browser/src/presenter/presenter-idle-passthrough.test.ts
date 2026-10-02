import { afterEach, describe, expect, it } from 'vitest';
import { PresenterMode } from '@reticlehq/core';
import { Presenter } from './presenter.js';

/**
 * An idle HUD was the element under the cursor.
 *
 * Playwright found the control, then timed out, and named `<div data-reticle-log>` inside an
 * overlay whose mode was idle and whose blocker was off. The log fills the chat card and had
 * pointer-events on, so the glass ate the click. The card is not in use in that state. Buttons
 * stay reachable; the transcript does not.
 */
const HUD_MOUNT_TIMEOUT_MS = 30_000;

afterEach(() => {
  document.querySelectorAll('[data-reticle-overlay]').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

describe(
  'an idle chat card does not take the page click',
  { timeout: HUD_MOUNT_TIMEOUT_MS },
  () => {
    it('lets the click through the log and keeps the minimise button', () => {
      const presenter = new Presenter({});
      presenter.mount();
      presenter.sessionStart();
      (document.querySelector('[data-reticle-fab]') as HTMLElement).click();
      const overlay = document.querySelector('div[data-reticle-overlay]') as HTMLElement;
      expect(overlay.getAttribute('data-reticle-mode')).toBe(PresenterMode.IDLE);
      expect(overlay.getAttribute('data-reticle-block')).toBe('0');
      const log = overlay.querySelector('[data-reticle-log]') as HTMLElement;
      const minimise = overlay.querySelector('[data-reticle-chat-min]') as HTMLElement;
      expect(getComputedStyle(log).pointerEvents).toBe('none');
      expect(getComputedStyle(minimise).pointerEvents).toBe('auto');
      presenter.setMode(PresenterMode.ACTING);
      expect(getComputedStyle(log).pointerEvents).toBe('auto');
      presenter.destroy();
    });
  },
);
