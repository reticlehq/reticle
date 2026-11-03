/**
 * A hover that moves to a second element leaves the first one.
 *
 * Field report on 3.9.0: a synthetic hover on a second Radix tooltip trigger sent no pointerleave to
 * the first trigger. The first tooltip stayed open, the second never opened, and a correct app was
 * verified `no`. A real pointer that moves from A to B always sends A its out and leave events, and
 * tooltip, menu and hover-card libraries close on them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

const LEAVE_EVENTS = ['pointerout', 'mouseout', 'pointerleave', 'mouseleave'] as const;

function twoTriggers(): { a: HTMLElement; b: HTMLElement; seen: Record<string, string[]> } {
  document.body.innerHTML =
    '<button id="a">Help</button><span> </span><button id="b">Settings</button>';
  const a = document.getElementById('a');
  const b = document.getElementById('b');
  if (null === a || null === b) {
    throw new Error('fixture');
  }
  const seen: Record<string, string[]> = { a: [], b: [] };
  for (const [name, el] of [
    ['a', a],
    ['b', b],
  ] as const) {
    for (const type of [...LEAVE_EVENTS, 'pointerover', 'pointerenter']) {
      el.addEventListener(type, () => seen[name]?.push(type));
    }
  }
  return { a, b, seen };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a hover that moves to another element', () => {
  it('sends the previously hovered element its out and leave events', async () => {
    const { a, b, seen } = twoTriggers();
    await executeAction(refs.refFor(a), 'hover', {});
    seen.a = [];
    await executeAction(refs.refFor(b), 'hover', {});
    for (const type of LEAVE_EVENTS) {
      expect(seen.a).toContain(type);
    }
    expect(seen.b).toContain('pointerover');
    expect(seen.b).toContain('pointerenter');
  });

  it('names the new element as relatedTarget on the leave, the way a real pointer does', async () => {
    const { a, b } = twoTriggers();
    let related: EventTarget | null = null;
    a.addEventListener('pointerout', (e) => {
      related = e.relatedTarget;
    });
    await executeAction(refs.refFor(a), 'hover', {});
    await executeAction(refs.refFor(b), 'hover', {});
    expect(related).toBe(b);
  });

  it('does not leave an element when the hover moves into its own child', async () => {
    document.body.innerHTML = '<div id="menu"><button id="item">Open</button></div>';
    const menu = document.getElementById('menu');
    const item = document.getElementById('item');
    if (null === menu || null === item) {
      throw new Error('fixture');
    }
    const left: string[] = [];
    menu.addEventListener('pointerleave', () => left.push('pointerleave'));
    menu.addEventListener('mouseleave', () => left.push('mouseleave'));
    await executeAction(refs.refFor(menu), 'hover', {});
    await executeAction(refs.refFor(item), 'hover', {});
    expect(left).toEqual([]);
  });

  it('sends nothing to an element that left the page since it was hovered', async () => {
    const { a, b, seen } = twoTriggers();
    await executeAction(refs.refFor(a), 'hover', {});
    a.remove();
    seen.a = [];
    await executeAction(refs.refFor(b), 'hover', {});
    expect(seen.a).toEqual([]);
  });
});
