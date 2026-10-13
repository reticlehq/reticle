/**
 * From a persona drive: a synthetic click meant for the next issue's assign menu landed on a menu
 * item of the PREVIOUS issue's menu, which was still animating closed (`data-state="closed"`), and
 * reassigned that issue. A person cannot click a menu that is on its way out; an act must not either.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

describe('an act aimed at an element that is leaving', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is refused inside a menu that is closing, with the reason, and nothing is clicked', async () => {
    document.body.innerHTML =
      '<div role="menu" data-state="closed"><div role="menuitem">Sam Okoro (you)</div></div>';
    const item = document.querySelector('[role="menuitem"]') as HTMLElement;
    let clicked = false;
    item.addEventListener('click', () => {
      clicked = true;
    });
    await expect(executeAction(refs.refFor(item), ActionType.CLICK)).rejects.toThrow(/closing/);
    expect(clicked).toBe(false);
  });

  it('still clicks a trigger whose own menu is closed, which is how a menu is opened', async () => {
    document.body.innerHTML = '<button aria-haspopup="menu" data-state="closed">Assign</button>';
    const trigger = document.querySelector('button') as HTMLElement;
    let clicked = false;
    trigger.addEventListener('click', () => {
      clicked = true;
    });
    await executeAction(refs.refFor(trigger), ActionType.CLICK);
    expect(clicked).toBe(true);
  });

  it('still clicks inside a closed accordion item’s header', async () => {
    document.body.innerHTML =
      '<div data-state="closed"><h3><button data-state="closed">Billing</button></h3></div>';
    const header = document.querySelector('button') as HTMLElement;
    await expect(executeAction(refs.refFor(header), ActionType.CLICK)).resolves.toBeDefined();
  });
});
