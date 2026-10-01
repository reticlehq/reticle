import { afterEach, describe, expect, it } from 'vitest';
import { hitTestOccluder } from './occlusion.js';

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
