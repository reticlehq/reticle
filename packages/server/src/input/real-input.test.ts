import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { boxCenter, capturePage, isPointerAction } from './real-input.js';

/** Records the options each page.screenshot() call receives and returns minimal PNG bytes. */
function recordingPage(calls: Record<string, unknown>[]): Page {
  return {
    screenshot: (opts: Record<string, unknown>) => {
      calls.push(opts);
      return Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    },
  } as unknown as Page;
}

describe('real-input pure helpers', () => {
  it('boxCenter returns the geometric center in CSS px', () => {
    expect(boxCenter({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ cx: 60, cy: 40 });
  });

  it('boxCenter handles a box at the origin', () => {
    expect(boxCenter({ x: 0, y: 0, width: 200, height: 100 })).toEqual({ cx: 100, cy: 50 });
  });

  it('boxCenter handles negative offsets (scrolled above viewport)', () => {
    expect(boxCenter({ x: -40, y: -20, width: 80, height: 40 })).toEqual({ cx: 0, cy: 0 });
  });

  it('isPointerAction is true for hover/click/dblclick/drag', () => {
    for (const action of ['hover', 'click', 'dblclick', 'drag']) {
      expect(isPointerAction(action)).toBe(true);
    }
  });

  it('isPointerAction is false for keyboard/value actions', () => {
    for (const action of [
      'fill',
      'type',
      'focus',
      'blur',
      'check',
      'uncheck',
      'select',
      'submit',
      'press',
      'scrollIntoView',
    ]) {
      expect(isPointerAction(action)).toBe(false);
    }
  });
});

describe('capturePage suppresses Reticle chrome for deterministic baselines', () => {
  it('hides the Reticle dev overlay and disables animations during a full-page capture', async () => {
    const calls: Record<string, unknown>[] = [];
    const bytes = await capturePage(recordingPage(calls), { fullPage: true });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(calls).toHaveLength(1);
    const opts = calls[0] ?? {};
    expect(String(opts['style'])).toContain('data-reticle-overlay');
    expect(String(opts['style'])).toContain('display:none');
    expect(opts['animations']).toBe('disabled');
    expect(opts['fullPage']).toBe(true);
  });

  it('forwards an explicit clip while still hiding the overlay', async () => {
    const calls: Record<string, unknown>[] = [];
    const clip = { x: 1, y: 2, width: 3, height: 4 };
    await capturePage(recordingPage(calls), { clip });
    const opts = calls[0] ?? {};
    expect(opts['clip']).toEqual(clip);
    expect(String(opts['style'])).toContain('data-reticle-overlay');
    expect(opts['fullPage']).toBeUndefined();
  });
});
