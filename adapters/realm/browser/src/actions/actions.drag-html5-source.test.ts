import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dragElement } from './actions-dom.js';

/**
 * An HTML5 drag starts on the draggable element, as a browser does it (#2401).
 *
 * A ref that names a wrapper whose child is `draggable="true"` used to fire `dragstart` on the
 * wrapper, which the child's listener never saw, so the app never began the drag.
 */
describe('dragElement starts the HTML5 drag from the draggable element', () => {
  const original = (globalThis as { DragEvent?: unknown }).DragEvent;

  beforeAll(() => {
    // jsdom has no DragEvent.
    (globalThis as { DragEvent?: unknown }).DragEvent = class extends MouseEvent {
      dataTransfer = null;
    };
  });

  afterAll(() => {
    (globalThis as { DragEvent?: unknown }).DragEvent = original;
  });

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const wire = (): { starts: string[]; dropped: () => number } => {
    const starts: string[] = [];
    let drops = 0;
    document.addEventListener('dragstart', (e) => starts.push((e.target as HTMLElement).id));
    document.getElementById('dest')?.addEventListener('drop', (e) => {
      drops += 1;
      e.preventDefault();
    });
    return { starts, dropped: () => drops };
  };

  it('fires dragstart on a draggable child of the named element', async () => {
    document.body.innerHTML =
      '<ul><li id="row"><div id="handle" draggable="true">x</div></li></ul><div id="dest">d</div>';
    const { starts, dropped } = wire();
    const row = document.getElementById('row') as HTMLElement;
    const dest = document.getElementById('dest') as HTMLElement;
    await dragElement(row, dest, undefined);
    expect(starts).toEqual(['handle']);
    expect(dropped()).toBe(1);
  });

  it('still fires dragstart on the element itself when it is draggable', async () => {
    document.body.innerHTML = '<div id="src" draggable="true">s</div><div id="dest">d</div>';
    const { starts } = wire();
    await dragElement(
      document.getElementById('src') as HTMLElement,
      document.getElementById('dest') as HTMLElement,
      undefined,
    );
    expect(starts).toEqual(['src']);
  });

  it('leaves the source alone when the wrapper has several draggable children', async () => {
    document.body.innerHTML =
      '<ul id="row"><li draggable="true" id="a">a</li><li draggable="true" id="b">b</li></ul><div id="dest">d</div>';
    const { starts } = wire();
    await dragElement(
      document.getElementById('row') as HTMLElement,
      document.getElementById('dest') as HTMLElement,
      undefined,
    );
    expect(starts).toEqual(['row']);
  });
});
