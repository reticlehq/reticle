// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '../dom/addressing/refs.js';

/**
 * The gestures a web app actually receives, and which of them Reticle could not produce.
 *
 * Each of these was undriveable rather than merely awkward — a handler bound to the event simply
 * never ran, so an agent asked to check the behaviour had no honest answer and the absence looked
 * like a pass.
 */
const mount = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  const el = document.body.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('fixture did not mount');
  return el;
};

const act = async (el: HTMLElement, action: string, args: Record<string, unknown> = {}) =>
  executeAction(refs.refFor(el), action, args);

describe('tap is a TOUCH, not a click with another name', () => {
  it('fires the touch sequence a finger produces, in order', async () => {
    const el = mount('<button>Save</button>');
    const seen: string[] = [];
    for (const type of ['pointerdown', 'touchstart', 'touchend', 'pointerup', 'click']) {
      el.addEventListener(type, () => seen.push(type));
    }
    await act(el, ActionType.TAP);
    expect(seen).toEqual(['pointerdown', 'touchstart', 'touchend', 'pointerup', 'click']);
  });

  it('says the pointer was a FINGER, which is the discriminator a touch handler reads', async () => {
    const el = mount('<button>Save</button>');
    let pointerType: string | undefined;
    el.addEventListener('pointerdown', (e) => {
      pointerType = e.pointerType;
    });
    await act(el, ActionType.TAP);
    expect(pointerType, 'an app that branches on pointerType must see touch').toBe('touch');
  });

  it('still delivers the trailing click, because a touch device synthesises one', async () => {
    // An app that only listens for `click` must work under a tap — that IS the thing worth checking.
    const el = mount('<button>Save</button>');
    const onClick = vi.fn();
    el.addEventListener('click', onClick);
    await act(el, ActionType.TAP);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('holds for a long press, and reports the hold it ACHIEVED', async () => {
    const el = mount('<button>Hold me</button>');
    const result = await act(el, ActionType.TAP, { holdMs: 30 });
    expect(result.effect?.heldMs ?? 0).toBeGreaterThanOrEqual(25);
  });
});

describe('a key can be HELD, as a mouse button already could', () => {
  it('emits the auto-repeat a browser sends while a key is down', async () => {
    // The repeats are the point: an app that counts keydowns to drive a press-and-hold progress bar
    // sees nothing from a bare down/up pair, so a hold with no repeat reports a gesture that
    // visibly did not happen.
    const el = mount('<input />');
    let repeats = 0;
    el.addEventListener('keydown', (e) => {
      if (e.repeat) repeats += 1;
    });
    await act(el, ActionType.PRESS, { key: 'Backspace', holdMs: 120 });
    expect(repeats).toBeGreaterThan(0);
  });

  it('releases the key exactly once, after the hold', async () => {
    const el = mount('<input />');
    const ups: number[] = [];
    el.addEventListener('keyup', () => ups.push(Date.now()));
    await act(el, ActionType.PRESS, { key: 'a', holdMs: 20 });
    expect(ups).toHaveLength(1);
  });
});

describe('several keys can be held together', () => {
  it('presses in order and releases in REVERSE, as a keyboard physically does', async () => {
    const el = mount('<input />');
    const log: string[] = [];
    el.addEventListener('keydown', (e) => log.push(`down:${e.key}`));
    el.addEventListener('keyup', (e) => log.push(`up:${e.key}`));
    await act(el, ActionType.PRESS, { keys: ['Control', 'k'] });
    expect(log).toEqual(['down:Control', 'down:k', 'up:k', 'up:Control']);
  });

  it('keeps modifiers working, since they are a different thing from held keys', async () => {
    const el = mount('<input />');
    let meta = false;
    el.addEventListener('keydown', (e) => {
      if ('k' === e.key) meta = e.metaKey;
    });
    await act(el, ActionType.PRESS, { key: 'k', modifiers: ['Meta'] });
    expect(meta, 'cmd+k must still be a modifier flag, not a held key').toBe(true);
  });
});

describe('scroll goes back, and sideways', () => {
  const scroller = (): HTMLElement => {
    // Longhand, not the `overflow` shorthand: jsdom's getComputedStyle does not expand it, so
    // `overflowY` reads `visible` and the element is not recognised as scrollable at all.
    const el = mount('<div style="overflow-y:auto;overflow-x:auto">content</div>');
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(el, 'scrollWidth', { value: 3000, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: 500, configurable: true });
    return el;
  };

  it('scrolls BACK on a negative dy — the direction that did not exist', async () => {
    const el = scroller();
    el.scrollTop = 900;
    await act(el, ActionType.SCROLL, { dy: -400 });
    expect(el.scrollTop, 'whatever scrolled past used to be unreachable').toBe(500);
  });

  it('scrolls sideways on dx, which inspect already reported and nothing could act on', async () => {
    const el = scroller();
    el.scrollLeft = 100;
    await act(el, ActionType.SCROLL, { dx: 250 });
    expect(el.scrollLeft).toBe(350);
  });
});

describe('zoom refuses rather than faking it', () => {
  it('will not approximate browser zoom with CSS, and says why', async () => {
    // A CSS zoom looks right in a screenshot and changes nothing a layout bug depends on: the
    // layout viewport, visualViewport and media queries all stay put. Reporting that as CHECKED is
    // worse than not supporting zoom — same rule as hover refusing without a native pointer.
    const el = mount('<div>page</div>');
    await expect(act(el, ActionType.ZOOM, { level: 2 })).rejects.toThrow(/cannot zoom from inside/);
    expect(document.documentElement.style.zoom, 'nothing may be faked on the way out').toBe('');
  });
});
