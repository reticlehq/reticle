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
import { clickGeometry } from './actions-dom.js';

const zero = new DOMRect(0, 0, 0, 0);

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint');
  document.body.replaceChildren();
});

describe('a click a person could not make', () => {
  it.each([false, true])(
    'names a Next dev overlay and resolves its real box (dialog=%s)',
    (dialog) => {
      const app = document.createElement('button');
      app.getBoundingClientRect = () => new DOMRect(20, 20, 60, 60);
      const portal = document.createElement('nextjs-portal');
      const root = portal.attachShadow({ mode: 'open' });
      const indicator = document.createElement('button');
      if (dialog) {
        indicator.setAttribute('data-nextjs-dialog', '');
      }
      indicator.textContent = 'N';
      indicator.getBoundingClientRect = () => new DOMRect(20, 20, 60, 60);
      root.append(indicator);
      document.body.append(app, portal);
      Object.defineProperty(document, 'elementFromPoint', {
        value: () => portal,
        configurable: true,
      });
      Object.defineProperty(root, 'elementFromPoint', { value: () => indicator });

      const geometry = clickGeometry(app);
      expect(geometry.occluded).toBe(true);
      expect(geometry.occluderName).toBe(dialog ? 'Next.js error dialog' : 'Next.js dev overlay');
      const blocker = refs.resolve(String(geometry.occludedBy));
      expect(blocker).toBe(indicator);
      expect(blocker?.getBoundingClientRect().toJSON()).toMatchObject({ width: 60, height: 60 });
    },
  );

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
