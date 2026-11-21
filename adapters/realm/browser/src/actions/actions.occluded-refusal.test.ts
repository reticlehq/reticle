/**
 * A click a person could not make is not sent.
 *
 * Reported from the field: `reticle_act_and_wait` clicked "Review & sign" while a modal covered it.
 * Reticle saw the cover and answered `verified: unknown`, but the synthetic click still reached the
 * button and opened a second signing dialog. Lowering the verdict after a consequential action is
 * too late. A covered target is now refused before dispatch, naming what covers it, unless the call
 * says `allowOccluded: true`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALLOW_OCCLUDED_ARG } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

/** A getBoundingClientRect stub returning a fixed viewport box. */
function rect(box: { left: number; top: number; width: number; height: number }): () => DOMRect {
  return (): DOMRect => ({
    x: box.left,
    y: box.top,
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
    toJSON: () => ({}),
  });
}

/** A button whose centre is covered by a dialog, and a counter of the clicks it received. */
function coveredButton(): { ref: string; clicks: () => number } {
  document.body.innerHTML =
    '<button>Review &amp; sign</button><div role="dialog" aria-label="Reports &amp; AI">x</div>';
  const btn = document.querySelector('button') as HTMLButtonElement;
  const cover = document.querySelector('[role="dialog"]') as HTMLElement;
  btn.getBoundingClientRect = rect({ left: 0, top: 0, width: 100, height: 40 });
  document.elementFromPoint = () => cover;
  let clicked = 0;
  btn.addEventListener('click', () => {
    clicked += 1;
  });
  return { ref: refs.refFor(btn), clicks: () => clicked };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  // jsdom has no elementFromPoint of its own; the stub goes, so the next file starts clean.
  Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('a click on a covered target', () => {
  it('is refused before dispatch, and names what covers it', async () => {
    const { ref, clicks } = coveredButton();
    await expect(executeAction(ref, 'click')).rejects.toThrow(/Reports & AI/);
    await expect(executeAction(ref, 'click')).rejects.toThrow(new RegExp(ALLOW_OCCLUDED_ARG));
    expect(clicks(), 'the covered button received the click').toBe(0);
  });

  it('is refused for a double click and a check too', async () => {
    const { ref } = coveredButton();
    await expect(executeAction(ref, 'dblclick')).rejects.toThrow(/covers/);
  });

  it('is sent when the call allows it, and still reports the cover', async () => {
    const { ref, clicks } = coveredButton();
    const r = await executeAction(ref, 'click', { [ALLOW_OCCLUDED_ARG]: true });
    expect(clicks()).toBe(1);
    expect(r.effect.occluded).toBe(true);
  });

  it('leaves an uncovered click alone', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    btn.getBoundingClientRect = rect({ left: 0, top: 0, width: 100, height: 40 });
    document.elementFromPoint = () => btn;
    const r = await executeAction(refs.refFor(btn), 'click');
    expect(r.effect.occluded).toBe(false);
  });

  // #2317: a Save button whose centre sat under a fixed bottom bar read as covered, though one
  // scroll brings it clear, which is what a person does before clicking.
  it('is not refused when a fixed bar covers it and one scroll brings it clear', async () => {
    document.body.innerHTML = '<button>Save</button><nav>bottom bar</nav>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    const nav = document.querySelector('nav') as HTMLElement;
    let scrolled = false;
    btn.getBoundingClientRect = rect({
      left: 0,
      top: scrolled ? 200 : 560,
      width: 100,
      height: 40,
    });
    btn.scrollIntoView = () => {
      scrolled = true;
      btn.getBoundingClientRect = rect({ left: 0, top: 200, width: 100, height: 40 });
    };
    document.elementFromPoint = () => (scrolled ? btn : nav);
    let clicks = 0;
    btn.addEventListener('click', () => {
      clicks += 1;
    });
    const r = await executeAction(refs.refFor(btn), 'click');
    expect(clicks).toBe(1);
    expect(r.effect.occluded).toBe(false);
  });

  it('is still refused when the cover stays after the scroll, as a modal does', async () => {
    const { ref, clicks } = coveredButton();
    const btn = document.querySelector('button') as HTMLButtonElement;
    btn.scrollIntoView = () => undefined;
    await expect(executeAction(ref, 'click')).rejects.toThrow(/covers the target/);
    expect(clicks()).toBe(0);
  });

  // CI e2e: a switch inside a closed <details> is not visible, and the hit test at its old place
  // lands on the visible switch beside it. That neighbour is not a cover; the story is "not
  // visible", which the verdict already tells. The refusal is for a visible target under a cover.
  it('is not refused for a target that is not visible at all', async () => {
    document.body.innerHTML =
      '<details><summary>Players</summary><button role="switch">Stream eligible</button></details>' +
      '<button role="switch">Stream public</button>';
    const hidden = document.querySelector('details button') as HTMLButtonElement;
    const neighbour = document.querySelectorAll('button')[1] as HTMLButtonElement;
    hidden.getBoundingClientRect = rect({ left: 0, top: 20, width: 100, height: 20 });
    document.elementFromPoint = () => neighbour;
    await expect(executeAction(refs.refFor(hidden), 'click')).resolves.toBeDefined();
  });
});
