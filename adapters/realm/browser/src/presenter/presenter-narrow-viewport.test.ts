import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Presenter } from './presenter.js';
import { rememberLeftOpen } from './presenter-shell.js';
import { CHAT_ATTR, FAB_ATTR, MIN_ATTR } from './presenter-config.js';

/**
 * On a phone-width page the HUD covered the app's controls (#2071).
 *
 * At 412 px the agent's first log row opened the 320 px chat panel by itself, over the app's
 * video-settings close control, and a trusted touch on that control then failed its hit-test. Below
 * 480 px the HUD stays a pill until somebody taps it. A desktop width keeps the behaviour it has today.
 */
const HUD_MOUNT_TIMEOUT_MS = 30_000;
const PHONE_WIDTH = 412;
const DESKTOP_WIDTH = 1280;
const originalWidth = window.innerWidth;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function overlay(): HTMLElement {
  return document.querySelector('div[data-reticle-overlay]') as HTMLElement;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  setViewportWidth(originalWidth);
  document.querySelectorAll('[data-reticle-overlay]').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

describe('the HUD on a narrow viewport', { timeout: HUD_MOUNT_TIMEOUT_MS }, () => {
  it('stays a pill when the agent logs its first row', () => {
    setViewportWidth(PHONE_WIDTH);
    const presenter = new Presenter({});
    presenter.mount();
    presenter.sessionStart();
    presenter.narrate('Opening the settings dialog');
    expect(overlay().getAttribute(CHAT_ATTR)).not.toBe('1');
    expect(overlay().getAttribute(MIN_ATTR)).toBe('1');
    presenter.destroy();
  });

  it('stays a pill on load even when the person left the panel open on a wider screen', () => {
    rememberLeftOpen(true);
    setViewportWidth(PHONE_WIDTH);
    const presenter = new Presenter({});
    presenter.mount();
    presenter.sessionStart();
    expect(overlay().getAttribute(CHAT_ATTR)).not.toBe('1');
    expect(overlay().getAttribute(MIN_ATTR)).toBe('1');
    presenter.destroy();
  });

  it('opens the panel when somebody taps the pill', () => {
    setViewportWidth(PHONE_WIDTH);
    const presenter = new Presenter({});
    presenter.mount();
    presenter.sessionStart();
    presenter.narrate('Opening the settings dialog');
    (document.querySelector(`[${FAB_ATTR}]`) as HTMLElement).click();
    expect(overlay().getAttribute(CHAT_ATTR)).toBe('1');
    presenter.destroy();
  });

  it('leaves a desktop width as it was: the first row opens the chat', () => {
    setViewportWidth(DESKTOP_WIDTH);
    const presenter = new Presenter({});
    presenter.mount();
    presenter.sessionStart();
    presenter.narrate('Opening the settings dialog');
    expect(overlay().getAttribute(CHAT_ATTR)).toBe('1');
    presenter.destroy();
  });
});
