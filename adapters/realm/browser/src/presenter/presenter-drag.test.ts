import { describe, it, expect, afterEach, vi } from 'vitest';
import { HUD_DRAGGED_ATTR, HUD_POS_X_VAR, HUD_POS_Y_VAR, MIN_ATTR } from './presenter-config.js';
import {
  applyHudPosition,
  clampHudPosition,
  installHudDrag,
  installHudPositionGuards,
  isHudDragged,
  relayoutHudPosition,
  resetHudDockPosition,
} from './presenter-drag.js';

afterEach(() => {
  document.querySelectorAll('[data-reticle-overlay]').forEach((e) => e.remove());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('presenter HUD drag', () => {
  it('clampHudPosition keeps the panel inside the viewport', () => {
    expect(clampHudPosition(0, 0, 392, 472, 1200, 800)).toEqual({ left: 8, top: 8 });
    expect(clampHudPosition(900, 400, 392, 472, 1200, 800)).toEqual({ left: 800, top: 320 });
  });

  it('clampHudPosition handles a viewport smaller than the panel', () => {
    expect(clampHudPosition(0, 0, 392, 472, 360, 400)).toEqual({ left: 8, top: 8 });
  });

  it('applyHudPosition stamps dragged coords onto the HUD', () => {
    const hud = document.createElement('div');
    applyHudPosition(hud, 120, 80);
    expect(hud.getAttribute(HUD_DRAGGED_ATTR)).toBe('1');
    expect(hud.style.getPropertyValue(HUD_POS_X_VAR)).toBe('120px');
    expect(isHudDragged(hud)).toBe(true);
  });

  it('relayoutHudPosition reclamps a dragged panel after its height shrinks', () => {
    const hud = document.createElement('div');
    document.body.append(hud);
    applyHudPosition(hud, 100, 700);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
    hud.getBoundingClientRect = (): DOMRect => ({
      left: 100,
      top: 700,
      right: 492,
      bottom: 750,
      width: 392,
      height: 50,
      x: 100,
      y: 700,
      toJSON: () => ({}),
    });
    relayoutHudPosition(hud);
    expect(hud.style.getPropertyValue(HUD_POS_X_VAR)).toBe('100px');
    expect(hud.style.getPropertyValue(HUD_POS_Y_VAR)).toBe('342px');
  });

  it('resetHudDockPosition clears dragged coordinates', () => {
    const hud = document.createElement('div');
    applyHudPosition(hud, 120, 80);
    expect(hud.getAttribute(HUD_DRAGGED_ATTR)).toBe('1');
    resetHudDockPosition(hud);
    expect(hud.getAttribute(HUD_DRAGGED_ATTR)).toBeNull();
    expect(hud.style.getPropertyValue(HUD_POS_X_VAR)).toBe('');
  });

  it('installHudDrag moves the HUD and reports drag movement', () => {
    const hud = document.createElement('div');
    const head = document.createElement('div');
    document.body.append(hud, head);
    Object.defineProperty(hud, 'offsetWidth', { configurable: true, value: 392 });
    Object.defineProperty(hud, 'offsetHeight', { configurable: true, value: 472 });
    hud.getBoundingClientRect = (): DOMRect => ({
      left: 404,
      top: 308,
      right: 796,
      bottom: 780,
      width: 392,
      height: 472,
      x: 404,
      y: 308,
      toJSON: () => ({}),
    });

    let dragged = false;
    const teardown = installHudDrag(hud, head, {
      onDragMove: () => {
        dragged = true;
      },
    });

    head.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 420,
        clientY: 320,
        pointerId: 1,
        button: 0,
      }),
    );
    head.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 520, clientY: 360, pointerId: 1 }),
    );
    head.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 520, clientY: 360, pointerId: 1 }),
    );

    expect(dragged).toBe(true);
    expect(hud.getAttribute(HUD_DRAGGED_ATTR)).toBe('1');
    expect(hud.style.getPropertyValue(HUD_POS_X_VAR)).toBe('504px');
    teardown();
  });

  it('installHudDrag moves the FAB while collapsed', () => {
    const hud = document.createElement('div');
    const fab = document.createElement('button');
    fab.type = 'button';
    document.body.append(hud, fab);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    hud.getBoundingClientRect = (): DOMRect => ({
      left: 404,
      top: 700,
      right: 448,
      bottom: 744,
      width: 44,
      height: 44,
      x: 404,
      y: 700,
      toJSON: () => ({}),
    });

    const teardown = installHudDrag(hud, fab);
    fab.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 410,
        clientY: 710,
        pointerId: 3,
        button: 0,
      }),
    );
    fab.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 500, clientY: 600, pointerId: 3 }),
    );
    fab.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 500, clientY: 600, pointerId: 3 }),
    );

    expect(hud.getAttribute(HUD_DRAGGED_ATTR)).toBe('1');
    expect(hud.style.getPropertyValue(HUD_POS_X_VAR)).toBe('494px');
    teardown();
  });

  it('installHudDrag teardown removes listeners', () => {
    const hud = document.createElement('div');
    const head = document.createElement('div');
    document.body.append(hud, head);
    const teardown = installHudDrag(hud, head);
    teardown();
    head.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 10,
        clientY: 10,
        pointerId: 2,
        button: 0,
      }),
    );
    expect(hud.getAttribute(HUD_DRAGGED_ATTR)).toBeNull();
  });

  it('installHudPositionGuards reclamps when the overlay minimises', async () => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-reticle-overlay', '');
    const hud = document.createElement('div');
    overlay.append(hud);
    document.body.append(overlay);
    applyHudPosition(hud, 100, 700);

    let height = 472;
    hud.getBoundingClientRect = (): DOMRect => ({
      left: 100,
      top: 700,
      right: 100 + 392,
      bottom: 700 + height,
      width: 392,
      height,
      x: 100,
      y: 700,
      toJSON: () => ({}),
    });

    const teardown = installHudPositionGuards(hud, overlay);
    height = 50;
    overlay.setAttribute(MIN_ATTR, '1');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
    expect(hud.style.getPropertyValue(HUD_POS_Y_VAR)).toBe('342px');
    teardown();
  });
});

/**
 * Teardown has to remove what install added.
 *
 * Both installers were already symmetric — every addEventListener had a matching remove — so this
 * is not a leak being fixed, it is the symmetry being made impossible to break. Which is only worth
 * anything if something notices when it IS broken, and nothing did: deleting either `abort()` left
 * the whole presenter suite green (187 passed).
 */
describe('presenter HUD drag teardown', () => {
  it('installHudDrag stops driving the HUD after teardown', () => {
    const hud = document.createElement('div');
    const head = document.createElement('div');
    document.body.append(hud, head);

    let dragged = false;
    const teardown = installHudDrag(hud, head, {
      onDragMove: () => {
        dragged = true;
      },
    });
    teardown();

    head.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 420,
        clientY: 320,
        pointerId: 9,
        button: 0,
      }),
    );
    head.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 500, clientY: 400, pointerId: 9 }),
    );

    expect(dragged, 'a pointer handler survived teardown').toBe(false);
    expect(isHudDragged(hud), 'the HUD moved after teardown').toBe(false);
  });

  it('installHudPositionGuards releases its window listeners on teardown', () => {
    const hud = document.createElement('div');
    const overlay = document.createElement('div');
    document.body.append(hud, overlay);

    // Asserting the signal rather than a side effect: the guards react to resize by SCHEDULING a
    // relayout, so a spy on the measurement sees nothing synchronously and the obvious behavioural
    // test passes whether or not the listener was removed. I wrote that version first and it stayed
    // green with the abort() deleted.
    const add = vi.spyOn(window, 'addEventListener');
    const teardown = installHudPositionGuards(hud, overlay);
    const signals = add.mock.calls
      .map(([, , options]) =>
        'object' === typeof options && null !== options ? options.signal : undefined,
      )
      .filter((sig): sig is AbortSignal => sig !== undefined);
    add.mockRestore();

    // Guards the guard: no signalled registration would make the loop below pass for free.
    expect(signals.length, 'the guards should register with a signal').toBeGreaterThan(0);
    expect(signals.some((sig) => sig.aborted)).toBe(false);

    teardown();

    expect(
      signals.every((sig) => sig.aborted),
      'a window listener outlived teardown',
    ).toBe(true);
  });
});
