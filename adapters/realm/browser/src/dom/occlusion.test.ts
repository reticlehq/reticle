import { afterEach, describe, expect, it } from 'vitest';
import { hitTestOccluder } from './occlusion.js';
import { setIgnoreSelectors } from './dom-ignore.js';
import { installShadowRegistry } from './shadow-registry.js';

/** jsdom has no layout, so elementFromPoint doesn't exist — install a controllable stub. */
function stubTopElement(ret: Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => ret,
    configurable: true,
    writable: true,
  });
}

describe('hitTestOccluder', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'elementFromPoint');
    document.body.innerHTML = '';
  });

  it('returns null for a zero-area rect (a size bug, not an occlusion)', () => {
    const el = document.createElement('button');
    expect(hitTestOccluder(el, new DOMRect(0, 0, 0, 0))).toBeNull();
  });

  it('returns null when the environment cannot hit-test (no elementFromPoint)', () => {
    const el = document.createElement('button');
    expect(hitTestOccluder(el, new DOMRect(0, 0, 10, 10))).toBeNull();
  });

  it('returns the foreign element covering the center as the occluder', () => {
    const el = document.createElement('button');
    const overlay = document.createElement('div');
    document.body.append(el, overlay);
    stubTopElement(overlay);
    expect(hitTestOccluder(el, new DOMRect(0, 0, 10, 10))).toBe(overlay);
  });

  it('is not occluded when the target itself, an ancestor, or a descendant is on top', () => {
    const wrapper = document.createElement('div');
    const el = document.createElement('button');
    const child = document.createElement('span');
    el.append(child);
    wrapper.append(el);
    document.body.append(wrapper);
    const rect = new DOMRect(0, 0, 10, 10);
    stubTopElement(el);
    expect(hitTestOccluder(el, rect)).toBeNull(); // itself
    stubTopElement(wrapper);
    expect(hitTestOccluder(el, rect)).toBeNull(); // ancestor wrapping it
    stubTopElement(child);
    expect(hitTestOccluder(el, rect)).toBeNull(); // descendant
  });

  it("never treats Reticle's own UI as an occluder", () => {
    const el = document.createElement('button');
    const hud = document.createElement('div');
    hud.setAttribute('data-reticle-overlay', '');
    document.body.append(el, hud);
    stubTopElement(hud);
    expect(hitTestOccluder(el, new DOMRect(0, 0, 10, 10))).toBeNull();
  });
});

/**
 * Sample more than the centre pixel.
 *
 * MEASURED: two bugs in this repo's own detection suite — `occluded` and `cmdk-occluded` — were
 * missed because the hit test asked about one point. An overlay that covers a control but happens to
 * miss its exact centre was invisible, and "covers it except for one pixel" is not a thing a user
 * can click through.
 *
 * The opposite failure is the one to fear, because this repo's cardinal metric is zero false
 * positives: partial overlap is NOT occlusion. A tooltip clipping one corner, a focus ring, a
 * sticky header grazing the top edge — all leave a usable control, and reporting them would teach
 * agents to ignore the finding. So the rule is a MAJORITY of sampled points, not any of them.
 */
function stubPerPoint(map: (x: number, y: number) => Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', {
    value: (x: number, y: number) => map(x, y),
    configurable: true,
    writable: true,
  });
}

describe('hitTestOccluder samples more than the centre', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'elementFromPoint');
    document.body.innerHTML = '';
  });

  it('catches an overlay that covers the control but misses the exact centre', () => {
    const el = document.createElement('button');
    const overlay = document.createElement('div');
    document.body.append(el, overlay);
    const rect = new DOMRect(0, 0, 100, 100);
    // Everything is the overlay EXCEPT the single centre point — the shape that was invisible.
    stubPerPoint((x, y) => (50 === x && 50 === y ? el : overlay));
    expect(hitTestOccluder(el, rect)).toBe(overlay);
  });

  it('does NOT report occlusion for partial overlap — a clipped corner is still clickable', () => {
    const el = document.createElement('button');
    const tooltip = document.createElement('div');
    document.body.append(el, tooltip);
    const rect = new DOMRect(0, 0, 100, 100);
    // One sampled corner only. Four of five points reach the control.
    stubPerPoint((x, y) => (x < 30 && y < 30 ? tooltip : el));
    expect(hitTestOccluder(el, rect)).toBeNull();
  });

  it('still reports a full-cover overlay, as it always did', () => {
    const el = document.createElement('button');
    const overlay = document.createElement('div');
    document.body.append(el, overlay);
    stubPerPoint(() => overlay);
    expect(hitTestOccluder(el, new DOMRect(0, 0, 100, 100))).toBe(overlay);
  });
});

/**
 * The stack form, which is the one the fix is about. Every test above stubs the SINGULAR
 * `elementFromPoint`, so none can see what `topAt` does with a stack. `stubStack` installs both —
 * the function refuses to run when `elementFromPoint` is missing.
 */
function stubStack(stack: (x: number, y: number) => Element[]): void {
  Object.defineProperty(document, 'elementFromPoint', {
    value: (x: number, y: number) => stack(x, y)[0] ?? null,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(document, 'elementsFromPoint', {
    value: (x: number, y: number) => stack(x, y),
    configurable: true,
    writable: true,
  });
}

function clearStubs(): void {
  Reflect.deleteProperty(document, 'elementFromPoint');
  Reflect.deleteProperty(document, 'elementsFromPoint');
  document.body.innerHTML = '';
}

/**
 * The target can BE Reticle's own UI.
 *
 * `topAt` drops our nodes so our presenter never counts as an occluder of an APP control (#783).
 * When the target is one of our nodes that filter removes the target from its own hit test, and the
 * first APP element underneath — the page our panel floats over — is blamed instead. Every
 * `reticle_act` on a panel control came back occluded, which is the one thing `exposePresenter`
 * exists to allow.
 */
describe('a Reticle control is not occluded by what is under our own panel', () => {
  afterEach(clearStubs);

  it('does not blame the app element under the panel for covering our own button', () => {
    const panel = document.createElement('div');
    panel.setAttribute('data-reticle-overlay', '');
    const hudButton = document.createElement('button');
    panel.append(hudButton);
    const app = document.createElement('div');
    document.body.append(panel, app);
    // The real stack at that point: our button on top, our panel under it, the app beneath both.
    stubStack(() => [hudButton, panel, app, document.body]);
    expect(hitTestOccluder(hudButton, new DOMRect(0, 0, 100, 100))).toBeNull();
  });

  it('still reports an APP modal that genuinely covers one of our controls', () => {
    // Narrowing to "our own subtree is not an occluder of it" must not become "our controls are
    // never occluded" — an app dialog over the panel is a real obstruction.
    const panel = document.createElement('div');
    panel.setAttribute('data-reticle-overlay', '');
    const hudButton = document.createElement('button');
    panel.append(hudButton);
    const modal = document.createElement('div');
    document.body.append(panel, modal);
    stubStack(() => [modal, hudButton, panel, document.body]);
    expect(hitTestOccluder(hudButton, new DOMRect(0, 0, 100, 100))).toBe(modal);
  });
});

/**
 * #783 has to survive the fix, and the tests that pinned it all used the singular form.
 *
 * Our overlay over an app control is not that control's occluder — the agent drives straight through
 * it. The stack form is where that is actually decided.
 */
describe('our chrome over an APP control stays invisible to the hit test', () => {
  afterEach(clearStubs);

  it('does not report our overlay as covering the app control beneath it', () => {
    const app = document.createElement('button');
    const hud = document.createElement('div');
    hud.setAttribute('data-reticle-overlay', '');
    document.body.append(app, hud);
    stubStack(() => [hud, app, document.body]);
    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBeNull();
  });

  it('still reports a real app overlay sitting between our chrome and the app control', () => {
    const app = document.createElement('button');
    const overlay = document.createElement('div');
    const hud = document.createElement('div');
    hud.setAttribute('data-reticle-overlay', '');
    document.body.append(app, overlay, hud);
    stubStack(() => [hud, overlay, app, document.body]);
    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBe(overlay);
  });
});

describe('dev overlays report what actually takes the pointer (#1698)', () => {
  afterEach(() => {
    clearStubs();
    setIgnoreSelectors([]);
  });

  function shadowHit(root: ShadowRoot, hit: Element | null): void {
    Object.defineProperty(root, 'elementFromPoint', { value: () => hit, configurable: true });
  }

  function nextOverlay(mode: ShadowRootMode = 'open'): {
    app: HTMLButtonElement;
    portal: Element;
    root: ShadowRoot;
    indicator: HTMLButtonElement;
  } {
    const app = document.createElement('button');
    const portal = document.createElement('nextjs-portal');
    portal.style.cssText = 'position: fixed; width: 0; height: 0;';
    const indicator = document.createElement('button');
    indicator.style.cssText = 'position: fixed; left: 0; top: 0; width: 100px; height: 100px;';
    const root = portal.attachShadow({ mode });
    root.append(indicator);
    document.body.append(app, portal);
    shadowHit(root, indicator);
    // Chrome retargets to the host only where shadow content takes the pointer.
    stubStack((x, y) => (x < 100 && y < 100 ? [portal, app, document.body] : [app, document.body]));
    return { app, portal, root, indicator };
  }

  it('leaves a target away from the shadow content unobstructed', () => {
    const { app } = nextOverlay();
    expect(hitTestOccluder(app, new DOMRect(200, 200, 100, 100))).toBeNull();
  });

  it('reports the covering shadow descendant instead of its zero-area host', () => {
    const { app, indicator } = nextOverlay();
    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBe(indicator);
  });

  it('counts different shadow children of one overlay as the same blocker', () => {
    const { app, root } = nextOverlay();
    const tiles = {
      topLeft: document.createElement('div'),
      topRight: document.createElement('div'),
      bottomLeft: document.createElement('div'),
      bottomRight: document.createElement('div'),
    };
    const grid = document.createElement('div');
    grid.style.cssText =
      'position: fixed; left: 0; top: 0; width: 100px; height: 100px; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;';
    grid.append(...Object.values(tiles));
    root.replaceChildren(grid);
    Object.defineProperty(root, 'elementFromPoint', {
      value: (x: number, y: number) => {
        if (y < 50) {
          return x < 50 ? tiles.topLeft : tiles.topRight;
        }
        return x < 50 ? tiles.bottomLeft : tiles.bottomRight;
      },
      configurable: true,
    });

    // The centre and bottom-right samples hit one tile. Each other sample hits a different tile.
    // All five samples are blocked by the same portal, even though no tile has three votes.
    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBe(tiles.bottomRight);
  });

  it('does not combine votes from separate dev-overlay hosts', () => {
    const { app, portal: left, indicator: leftIndicator } = nextOverlay();
    const { app: otherApp, portal: right, indicator: rightIndicator } = nextOverlay();
    otherApp.remove();
    leftIndicator.style.width = '30px';
    rightIndicator.style.left = '70px';
    rightIndicator.style.width = '30px';
    stubStack((x) => {
      if (x < 30) {
        return [left, app, document.body];
      }
      if (x > 70) {
        return [right, app, document.body];
      }
      return [app, document.body];
    });

    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBeNull();
  });

  it('reports the indicator inside a full-viewport pointer-events:none host', () => {
    const { app, portal, indicator } = nextOverlay();
    portal.setAttribute('style', 'position: fixed; inset: 0; pointer-events: none;');
    indicator.style.pointerEvents = 'auto';
    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBe(indicator);
  });

  it('retains a host that itself takes the pointer', () => {
    const { app, portal, root, indicator } = nextOverlay();
    portal.setAttribute('style', 'position: fixed; inset: 0;');
    indicator.style.pointerEvents = 'none';
    shadowHit(root, portal);
    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBe(portal);
  });

  it('resolves a captured closed root', () => {
    const uninstall = installShadowRegistry();
    try {
      const { app, portal, indicator } = nextOverlay('closed');
      expect(portal.shadowRoot).toBeNull();
      expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBe(indicator);
    } finally {
      uninstall();
    }
  });

  it('resolves nested shadow hosts to the element under the sampled point', () => {
    const { app, root } = nextOverlay();
    const nested = document.createElement('div');
    const inner = document.createElement('button');
    const nestedRoot = nested.attachShadow({ mode: 'open' });
    nestedRoot.append(inner);
    root.replaceChildren(nested);
    shadowHit(root, nested);
    shadowHit(nestedRoot, inner);
    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBe(inner);
  });

  it('does not blame an ignored host for covering a target inside its shadow root', () => {
    const { app, portal, root } = nextOverlay();
    root.replaceChildren(app);
    shadowHit(root, app);
    stubStack(() => [portal, document.body]);
    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBeNull();
  });

  it('keeps the host when its shadow hit-test API is unavailable', () => {
    const { app, portal, root } = nextOverlay();
    Object.defineProperty(root, 'elementFromPoint', { value: undefined, configurable: true });
    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBe(portal);
  });

  it.each(['data-agentation', 'data-nextjs-toast', 'data-nextjs-dialog', 'data-custom-widget'])(
    'does not hide a light-DOM blocker excluded from snapshots by %s',
    (attribute) => {
      const app = document.createElement('button');
      const overlay = document.createElement('div');
      overlay.setAttribute(attribute, '');
      setIgnoreSelectors(['[data-custom-widget]']);
      document.body.append(app, overlay);
      stubStack(() => [overlay, app, document.body]);
      expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBe(overlay);
    },
  );

  it('still reports an app overlay above the dev-tools host', () => {
    const app = document.createElement('button');
    const overlay = document.createElement('div');
    const portal = document.createElement('nextjs-portal');
    document.body.append(app, overlay, portal);
    stubStack(() => [overlay, portal, app, document.body]);
    expect(hitTestOccluder(app, new DOMRect(0, 0, 100, 100))).toBe(overlay);
  });
});
