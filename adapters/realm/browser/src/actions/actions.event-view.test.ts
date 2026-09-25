/** Regression for #995: synthetic input must carry the target document's window. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { refs } from '@/dom/addressing/refs.js';
import { executeAction } from './actions.js';
import {
  dragElement,
  fireClickSequence,
  firePointer,
  firePointerNonBubbling,
  fireTapSequence,
} from './actions-dom.js';

const CLICK_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
function capture(element: Element, types: readonly string[]): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const type of types)
    element.addEventListener(type, (event) => events.push(event as MouseEvent));
  return events;
}
beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('synthetic mouse and pointer input has the correct view', () => {
  it('supplies a window through the complete click sequence', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    const events = capture(button, CLICK_EVENTS);
    await fireClickSequence(button);
    expect(events.map((event) => event.type)).toEqual(CLICK_EVENTS);
    expect(events.map((event) => event.view)).toEqual(CLICK_EVENTS.map(() => window));
  });
  it('uses an iframe target window rather than the global window', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    if (null === doc) throw new Error('test iframe has no document');
    const button = doc.createElement('button');
    doc.body.append(button);
    const events = capture(button, CLICK_EVENTS);
    await fireClickSequence(button);
    expect(events).toHaveLength(CLICK_EVENTS.length);
    for (const event of events) expect(event.view).toBe(doc.defaultView);
    expect(doc.defaultView).not.toBe(window);
  });

  it.each([false, true])('preserves view with PointerEvent available: %s', (available) => {
    vi.stubGlobal('PointerEvent', available ? MouseEvent : undefined);
    const button = document.createElement('button');
    const events = capture(button, ['pointerover', 'pointerenter']);
    firePointer(button, 'pointerover');
    firePointerNonBubbling(button, 'pointerenter');
    expect(events.map((event) => event.view)).toEqual([window, window]);
    expect(events.map((event) => event.bubbles)).toEqual([true, false]);
  });
  it('keeps touch pointer input and its compatibility click in the target window', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    const events = capture(button, ['pointerdown', 'pointerup', 'click']);
    await fireTapSequence(button, undefined);
    expect(events.map((event) => event.view)).toEqual([window, window, window]);
  });

  it.each([ActionType.HOVER, ActionType.DBLCLICK, ActionType.CHECK, ActionType.UNCHECK])(
    'supplies view for %s dispatched through executeAction',
    async (action) => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = action === ActionType.UNCHECK;
      document.body.append(input);
      const events = capture(input, [
        'pointerover',
        'pointerenter',
        'pointermove',
        'mouseover',
        'mouseenter',
        'mousemove',
        'dblclick',
        'click',
      ]);
      await executeAction(refs.refFor(input), action, {});
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect(event.view).toBe(window);
    },
  );
  it('lets a drag handler attach move and release listeners through event.view', async () => {
    const source = document.createElement('div');
    const target = document.createElement('div');
    document.body.append(source, target);
    const events = capture(source, ['pointerdown', 'mousedown']);
    const moves = vi.fn();
    const releases = vi.fn();
    source.addEventListener('mousedown', (event) => {
      event.view?.addEventListener('mousemove', moves);
      event.view?.addEventListener('mouseup', releases);
    });
    try {
      await dragElement(source, target, undefined);
      expect(events.map((event) => event.view)).toEqual([window, window]);
      expect(moves).toHaveBeenCalled();
      expect(releases).toHaveBeenCalledOnce();
      const move = moves.mock.calls[0]?.[0] as MouseEvent | undefined;
      expect(move?.view).toBe(window);
    } finally {
      window.removeEventListener('mousemove', moves);
      window.removeEventListener('mouseup', releases);
    }
  });
});

it('preserves a null view for an element in a detached document', async () => {
  const doc = document.implementation.createHTMLDocument('Detached');
  const button = doc.createElement('button');
  doc.body.append(button);
  const events = capture(button, CLICK_EVENTS);
  await fireClickSequence(button);
  expect(doc.defaultView).toBeNull();
  expect(events).toHaveLength(CLICK_EVENTS.length);
  for (const event of events) expect(event.view).toBeNull();
});

it('dispatches a complete double-click sequence', async () => {
  const button = document.createElement('button');
  document.body.append(button);

  const events = capture(button, ['mousedown', 'mouseup', 'click', 'dblclick']);
  const clicks = vi.fn();

  button.addEventListener('click', clicks);

  await executeAction(refs.refFor(button), ActionType.DBLCLICK, {});

  expect(events.map((event) => [event.type, event.detail])).toEqual([
    ['mousedown', 1],
    ['mouseup', 1],
    ['click', 1],
    ['mousedown', 2],
    ['mouseup', 2],
    ['click', 2],
    ['dblclick', 2],
  ]);

  expect(clicks).toHaveBeenCalledTimes(2);
});
