/**
 * Reticle's own UI moving during an action is not the action's effect.
 *
 * The HUD reacts to every act: it sets `data-busy`, moves its chip and writes a log row. The act's
 * mutation count watched the whole document, so on any page with the HUD mounted a click on a
 * button with no handler counted those mutations as its effect. `action-had-no-effect` then never
 * fired, and `act_and_wait` returned `no-fault` for a dead button (#2141, found by the bench-app
 * rule-pairs fixture).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

/** Plays the HUD: Reticle's own UI changes while the act is in flight. */
function hudThatReacts(): () => void {
  const hud = document.createElement('div');
  hud.setAttribute('data-reticle-hud', '');
  const chip = document.createElement('span');
  hud.append(chip);
  document.body.append(hud);
  const react = (): void => {
    hud.setAttribute('data-busy', 'true');
    chip.textContent = 'click';
    hud.append(document.createElement('div'));
  };
  document.addEventListener('click', react, true);
  return () => document.removeEventListener('click', react, true);
}

let stopHud: () => void = () => undefined;

beforeEach(() => {
  document.body.innerHTML = '';
  stopHud = hudThatReacts();
});

afterEach(() => {
  stopHud();
});

describe('the act mutation count and Reticle UI', () => {
  it('counts nothing for a dead button while the HUD reacts to the click', async () => {
    const button = document.createElement('button');
    button.textContent = 'Archive';
    document.body.append(button);
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.domMutatedWithin).toBe(0);
  });

  it('still counts an app change outside the target, such as a counter beside the button', async () => {
    const button = document.createElement('button');
    button.textContent = '+';
    const count = document.createElement('span');
    count.textContent = '0';
    button.addEventListener('click', () => {
      count.textContent = '1';
    });
    document.body.append(button, count);
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.domMutatedWithin).toBeGreaterThan(0);
  });
});
