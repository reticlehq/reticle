/**
 * A control that does not take pointer events cannot be clicked by a person: the pointer lands on
 * whatever is under it. Measured on a modal's error alert, whose dismiss button a stylesheet rule set
 * to `pointer-events: none`. The hit test found the alert (an ancestor) on top, read that as "not
 * covered", and the synthetic click ran the dismiss handler that no person could reach. jsdom has no
 * layout, so the box and the hit test are stubbed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

function topElementIs(el: Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => el,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint');
  document.body.replaceChildren();
});

describe('a click on a control that does not take pointer events', () => {
  it('reports the element the pointer lands on as covering it', async () => {
    document.body.innerHTML =
      '<div role="alert">Permission denied.<button aria-label="Dismiss error" style="pointer-events: none">x</button></div>';
    const alert = document.querySelector('[role="alert"]') as HTMLElement;
    const button = document.querySelector('button') as HTMLElement;
    button.getBoundingClientRect = () => new DOMRect(0, 0, 18, 18);
    topElementIs(alert);
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.occluded).toBe(true);
    expect(r.effect.occluderName).toContain('alert');
  });

  it('is reachable through its label when it is a labelled form control', async () => {
    document.body.innerHTML =
      '<label id="l">Remember me <input type="checkbox" style="pointer-events: none" /></label>';
    const label = document.getElementById('l') as HTMLElement;
    const box = document.querySelector('input') as HTMLElement;
    box.getBoundingClientRect = () => new DOMRect(0, 0, 16, 16);
    topElementIs(label);
    const r = await executeAction(refs.refFor(box), 'click');
    expect(r.effect.occluded).toBe(false);
  });

  it('is unchanged for a control that takes pointer events and has an ancestor on top', async () => {
    document.body.innerHTML = '<p id="p">See <a href="#x">the guide</a></p>';
    const p = document.getElementById('p') as HTMLElement;
    const link = document.querySelector('a') as HTMLElement;
    link.getBoundingClientRect = () => new DOMRect(0, 0, 60, 30);
    topElementIs(p);
    const r = await executeAction(refs.refFor(link), 'click');
    expect(r.effect.occluded).toBe(false);
  });
});
