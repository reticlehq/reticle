import { describe, expect, it } from 'vitest';
import {
  ActionType,
  RETICLE_CHROME_PASS_THROUGH_SCRIPT,
  RETICLE_CHROME_RESTORE_POINTER_SCRIPT,
} from '@reticlehq/core';
import type { Page } from 'playwright';
import { performGesture } from './real-input.js';

/** Records keyboard and mouse calls in one ordered list, so a held key can be seen around a click. */
function recordingPage(): { page: Page; calls: string[] } {
  const calls: string[] = [];
  const page = {
    evaluate: (script: string) => {
      if (script === RETICLE_CHROME_PASS_THROUGH_SCRIPT) {
        calls.push('hud:through');
      } else if (script === RETICLE_CHROME_RESTORE_POINTER_SCRIPT) {
        calls.push('hud:restore');
      }
      return Promise.resolve();
    },
    keyboard: {
      down: (key: string) => {
        calls.push(`down:${key}`);
        return Promise.resolve();
      },
      up: (key: string) => {
        calls.push(`up:${key}`);
        return Promise.resolve();
      },
    },
    mouse: {
      move: () => Promise.resolve(),
      click: (_x: number, _y: number, opts?: { button?: string }) => {
        calls.push(`click:${opts?.button ?? 'default'}`);
        return Promise.resolve();
      },
      dblclick: (_x: number, _y: number, opts?: { button?: string }) => {
        calls.push(`dblclick:${opts?.button ?? 'default'}`);
        return Promise.resolve();
      },
      down: () => {
        calls.push('down');
        return Promise.resolve();
      },
      up: () => {
        calls.push('up');
        return Promise.resolve();
      },
    },
  } as unknown as Page;
  return { page, calls };
}

const BOX = { x: 0, y: 0, width: 10, height: 10 };
/** The gesture calls alone, without the HUD pass-through around them. */
const gestureOnly = (calls: string[]): string[] => calls.filter((c) => !c.startsWith('hud:'));
const noSleep = (): Promise<void> => Promise.resolve();

describe('performGesture: a real click with modifiers and a button', () => {
  it('holds each modifier down around the click and releases in reverse', async () => {
    const { page, calls } = recordingPage();
    await performGesture(page, ActionType.CLICK, BOX, { modifiers: ['Shift', 'cmd'] }, noSleep);
    expect(gestureOnly(calls)).toEqual([
      'down:Meta',
      'down:Shift',
      'click:default',
      'up:Shift',
      'up:Meta',
    ]);
  });

  it('releases the modifiers when the click throws', async () => {
    const { page, calls } = recordingPage();
    (page.mouse as { click: unknown }).click = () => Promise.reject(new Error('boom'));
    await expect(
      performGesture(page, ActionType.CLICK, BOX, { modifiers: ['Shift'] }, noSleep),
    ).rejects.toThrow('boom');
    expect(gestureOnly(calls)).toEqual(['down:Shift', 'up:Shift']);
  });

  it('passes the button through to the mouse', async () => {
    const { page, calls } = recordingPage();
    await performGesture(page, ActionType.CLICK, BOX, { button: 'right' }, noSleep);
    expect(gestureOnly(calls)).toEqual(['click:right']);
  });

  it('holds modifiers around a dblclick', async () => {
    const { page, calls } = recordingPage();
    await performGesture(page, ActionType.DBLCLICK, BOX, { modifiers: ['Alt'] }, noSleep);
    expect(gestureOnly(calls)).toEqual(['down:Alt', 'dblclick:default', 'up:Alt']);
  });
});

/**
 * A real click from Reticle landed on Reticle's own HUD (#992). The HUD sat over the app's button,
 * the HUD control under the button's centre took the click, and the verdict said the app did
 * nothing. A drag in the same session ended one cell short. Every pointer gesture now runs with
 * Reticle's own UI out of the hit test, and the UI takes clicks again after it.
 */
describe('performGesture: a real pointer looks through the HUD', () => {
  it('makes the HUD pass the pointer through for a click, and restores it after', async () => {
    const { page, calls } = recordingPage();
    await performGesture(page, ActionType.CLICK, BOX, {}, noSleep);
    expect(calls).toEqual(['hud:through', 'click:default', 'hud:restore']);
  });

  it('does the same for the whole of a drag', async () => {
    const { page, calls } = recordingPage();
    await performGesture(page, ActionType.DRAG, BOX, { toBox: BOX, steps: 1 }, noSleep);
    expect(calls).toEqual(['hud:through', 'down', 'up', 'hud:restore']);
  });

  it('restores the HUD when the gesture throws', async () => {
    const { page, calls } = recordingPage();
    (page.mouse as { click: unknown }).click = () => Promise.reject(new Error('boom'));
    await expect(performGesture(page, ActionType.CLICK, BOX, {}, noSleep)).rejects.toThrow('boom');
    expect(calls).toEqual(['hud:through', 'hud:restore']);
  });
});
