import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ActionWarning } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '../dom/refs.js';

function refOf(selector: string): string {
  const el = document.querySelector(selector);
  if (el === null) throw new Error(`no element for ${selector}`);
  return refs.refFor(el);
}

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

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  // jsdom does not implement elementFromPoint; drop the per-test stub (an own property) so the
  // native (absent) behavior is restored for the next test.
  delete (document as Partial<Document>).elementFromPoint;
});

describe('click: full pointer/mouse event sequence', () => {
  it('fires pointerdown -> mousedown -> pointerup -> mouseup -> click in order', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    const seen: string[] = [];
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      btn.addEventListener(t, () => seen.push(t));
    }
    await executeAction(refs.refFor(btn), 'click');
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  it('still reports defaultPrevented from the click event', async () => {
    document.body.innerHTML = '<a href="#">link</a>';
    const a = document.querySelector('a') as HTMLAnchorElement;
    a.addEventListener('click', (e) => {
      e.preventDefault();
    });
    const r = await executeAction(refs.refFor(a), 'click');
    expect(r.effect.defaultPrevented).toBe(true);
  });
});

describe('click: hit-test occlusion honesty', () => {
  it('occluded=true + CLICK_OCCLUDED warning when the center is covered by a foreign element', async () => {
    document.body.innerHTML = '<button>Save</button><div id="cover">x</div>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    const cover = document.querySelector('#cover') as HTMLElement;
    btn.getBoundingClientRect = rect({ left: 0, top: 0, width: 100, height: 40 });
    document.elementFromPoint = () => cover;

    const r = await executeAction(refs.refFor(btn), 'click');

    expect(r.effect.occluded).toBe(true);
    expect(r.warning).toBe(ActionWarning.CLICK_OCCLUDED);
  });

  it('occluded=false when the hit-test resolves to the target itself', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    btn.getBoundingClientRect = rect({ left: 0, top: 0, width: 100, height: 40 });
    document.elementFromPoint = () => btn;

    const r = await executeAction(refs.refFor(btn), 'click');

    expect(r.effect.occluded).toBe(false);
    expect(r.warning).toBeUndefined();
  });

  it('occluded=false when the hit-test resolves to a descendant of the target', async () => {
    document.body.innerHTML = '<button><span id="lbl">Save</span></button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    const span = document.querySelector('#lbl') as HTMLElement;
    btn.getBoundingClientRect = rect({ left: 0, top: 0, width: 100, height: 40 });
    document.elementFromPoint = () => span;

    const r = await executeAction(refs.refFor(btn), 'click');

    expect(r.effect.occluded).toBe(false);
  });

  it('occluded=false (not hit-tested) for a zero-area box, e.g. jsdom with no layout', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const r = await executeAction(refOf('button'), 'click');
    expect(r.effect.occluded).toBe(false);
  });
});

describe('click: off-viewport auto scroll', () => {
  it('scrolls an off-viewport target into view before dispatch', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    let scrolled = false;
    btn.scrollIntoView = () => {
      scrolled = true;
    };
    btn.getBoundingClientRect = rect({ left: 0, top: 5000, width: 100, height: 40 });
    document.elementFromPoint = () => btn;

    const r = await executeAction(refs.refFor(btn), 'click');

    expect(scrolled).toBe(true);
    expect(r.effect.scrolledIntoView).toBe(true);
  });

  it('does not scroll a target already in the viewport', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    let scrolled = false;
    btn.scrollIntoView = () => {
      scrolled = true;
    };
    btn.getBoundingClientRect = rect({ left: 0, top: 10, width: 100, height: 40 });
    document.elementFromPoint = () => btn;

    const r = await executeAction(refs.refFor(btn), 'click');

    expect(scrolled).toBe(false);
    expect(r.effect.scrolledIntoView).toBe(false);
  });
});
