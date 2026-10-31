/**
 * A click a real user could not make must say so in words the verdict can carry. Driving bench-app,
 * an occluded nav link and a 0×0 submit button both came back verified "yes": synthetic dispatch
 * reached them, and the effect named the cover only by ref and said nothing about the size.
 * jsdom has no layout, so boxes and hit tests are stubbed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';
import { setPresenterVisible } from '@/dom/dom-ignore.js';

const zero = new DOMRect(0, 0, 0, 0);

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint');
  document.body.replaceChildren();
});

describe('a click a person could not make', () => {
  it('names what covers the target, not only its ref', async () => {
    document.body.innerHTML =
      '<a href="#d" data-testid="nav-deployments">Deployments</a><div data-testid="sheet"></div>';
    const link = document.querySelector('a') as HTMLElement;
    const sheet = document.querySelector('div') as HTMLElement;
    link.getBoundingClientRect = () => new DOMRect(0, 0, 40, 20);
    Object.defineProperty(document, 'elementFromPoint', {
      value: () => sheet,
      configurable: true,
      writable: true,
    });
    const r = await executeAction(refs.refFor(link), 'click');
    expect(r.effect.occluded).toBe(true);
    expect(r.effect.occluderName).toBe('[data-testid="sheet"]');
  });

  it('says the target has no size when its laid-out box is 0×0', async () => {
    document.body.innerHTML = '<button data-testid="login-submit">Sign in</button>';
    const button = document.querySelector('button') as HTMLElement;
    button.getBoundingClientRect = () => zero;
    button.getClientRects = () => [zero] as unknown as DOMRectList;
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.noSize).toBe(true);
  });

  /*
   * A table cell collapsed a row checkbox to 0×16: no box to click, nothing on screen. The old rule
   * asked only whether the box had width OR height, so 0×16 counted as clickable and a flow that
   * checked every row "passed" on a page where no user could select a row.
   */
  it('says the target has no size when only one side of its box is zero', async () => {
    document.body.innerHTML = '<input type="checkbox" aria-label="Select u25" />';
    const box = document.querySelector('input') as HTMLElement;
    const thin = new DOMRect(40, 100, 0, 16);
    box.getBoundingClientRect = () => thin;
    box.getClientRects = () => [thin] as unknown as DOMRectList;
    Object.defineProperty(document, 'elementFromPoint', {
      value: () => box,
      configurable: true,
      writable: true,
    });
    const r = await executeAction(refs.refFor(box), 'check');
    expect(r.effect.noSize).toBe(true);
  });

  /*
   * Many apps hide the real checkbox and draw a styled label. A person clicks the label, and the
   * label toggles the input, so the control IS reachable: it must not be reported as sizeless.
   */
  it('treats a sizeless input with a visible label as reachable through the label', async () => {
    document.body.innerHTML =
      '<label id="lbl"><input type="checkbox" id="cb" /> Show advanced options</label>';
    const box = document.querySelector('#cb') as HTMLElement;
    const label = document.querySelector('#lbl') as HTMLElement;
    const none = new DOMRect(10, 10, 0, 0);
    box.getBoundingClientRect = () => none;
    box.getClientRects = () => [none] as unknown as DOMRectList;
    const shown = new DOMRect(10, 10, 160, 20);
    label.getBoundingClientRect = () => shown;
    label.getClientRects = () => [shown] as unknown as DOMRectList;
    Object.defineProperty(document, 'elementFromPoint', {
      value: () => label,
      configurable: true,
      writable: true,
    });
    const r = await executeAction(refs.refFor(box), 'check');
    expect(r.effect.noSize).toBeUndefined();
    expect(r.effect.occluded).toBeFalsy();
  });

  it('says nothing about size when there is no layout at all', async () => {
    document.body.innerHTML = '<button>Sign in</button>';
    const button = document.querySelector('button') as HTMLElement;
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.noSize).toBeUndefined();
    expect(r.effect.offViewport).toBeUndefined();
  });

  it('says the target is still off screen when scrolling it into view did not bring it in', async () => {
    document.body.innerHTML = '<button>Far away</button>';
    const button = document.querySelector('button') as HTMLElement;
    button.getBoundingClientRect = () => new DOMRect(5000, 5000, 40, 20);
    button.scrollIntoView = () => undefined;
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.scrolledIntoView).toBe(true);
    expect(r.effect.offViewport).toBe(true);
  });
});

/*
 * With the HUD exposed, an agent's clicks on Reticle's own panel were recorded into the app's
 * auto-saved flow. The act result says when its target is Reticle's own UI, so the recorder can
 * leave it out.
 */
describe("an act on Reticle's own UI", () => {
  it('says so in its result', async () => {
    setPresenterVisible(true);
    document.body.innerHTML =
      '<div data-reticle-hud><button>Run Harness</button></div><button>Sign in</button>';
    const [hud, app] = Array.from(document.querySelectorAll('button'));
    expect((await executeAction(refs.refFor(hud as HTMLElement), 'click')).reticleUi).toBe(true);
    expect(
      (await executeAction(refs.refFor(app as HTMLElement), 'click')).reticleUi,
    ).toBeUndefined();
    setPresenterVisible(false);
  });
});
