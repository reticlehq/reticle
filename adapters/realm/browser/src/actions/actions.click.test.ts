import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ActionWarning } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

function refOf(selector: string): string {
  const el = document.querySelector(selector);
  if (null === el) throw new Error(`no element for ${selector}`);
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

describe('dblclick: the sequence a real double-click produces', () => {
  it('fires two full clicks before the dblclick, with detail counting up', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    const seen: string[] = [];
    for (const t of ['mousedown', 'mouseup', 'click', 'dblclick']) {
      btn.addEventListener(t, (e) => seen.push(`${t}:${(e as MouseEvent).detail}`));
    }
    await executeAction(refs.refFor(btn), 'dblclick');
    expect(seen).toEqual([
      'mousedown:1',
      'mouseup:1',
      'click:1',
      'mousedown:2',
      'mouseup:2',
      'click:2',
      'dblclick:2',
    ]);
  });

  it('runs an onClick-style click handler twice', async () => {
    document.body.innerHTML = '<button>Submit</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    let clicks = 0;
    btn.addEventListener('click', () => {
      clicks += 1;
    });
    await executeAction(refs.refFor(btn), 'dblclick');
    expect(clicks).toBe(2);
  });

  it('reports defaultPrevented from the dblclick event', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
    });
    const r = await executeAction(refs.refFor(btn), 'dblclick');
    expect(r.effect.defaultPrevented).toBe(true);
  });
});

describe('click: SVG targets', () => {
  // Charts, maps and icon buttons put the clickable shape in SVG. A `<path>` is an SVGElement, not an
  // HTMLElement, and was refused outright.
  it('clicks a <path> inside an <svg> and reports ok', async () => {
    document.body.innerHTML =
      '<svg viewBox="0 0 10 10"><path id="slice" d="M0 0 L10 0 L10 10 Z"></path></svg>';
    const seen: string[] = [];
    const path = document.querySelector('#slice');
    path?.addEventListener('click', () => seen.push('click'));
    const r = await executeAction(refOf('#slice'), 'click');
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['click']);
  });

  it('hovers an SVG element', async () => {
    document.body.innerHTML = '<svg><circle id="dot" r="4"></circle></svg>';
    const seen: string[] = [];
    document.querySelector('#dot')?.addEventListener('mouseenter', () => seen.push('enter'));
    const r = await executeAction(refOf('#dot'), 'hover');
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['enter']);
  });
});

describe('click: a target that is not a control (#1356)', () => {
  it('warns when the click lands on a wrapper that is not a control and sits inside none', async () => {
    // `{ text: "Sign in" }` matched the div's own text, not the icon button inside it. The click hit
    // the div, the form never submitted, and the act used to report a clean click.
    document.body.innerHTML =
      '<div id="wrap">Sign in <button aria-label="Continue"><svg></svg></button></div>';

    const r = await executeAction(refOf('#wrap'), 'click');

    expect(r.warning).toBe(ActionWarning.CLICK_NOT_A_CONTROL);
  });

  it.each([
    ['a real button', '<button id="t">Save</button>'],
    ['text inside a button', '<button><span id="t">Save</span></button>'],
    [
      'text inside a label',
      '<label><span id="t">Remember me</span><input type="checkbox"></label>',
    ],
    ['an element with an onclick attribute', '<div id="t" onclick="void 0">Open</div>'],
    ['an element with a tabindex', '<div id="t" tabindex="0">Open</div>'],
    [
      'an element styled as clickable',
      '<div style="cursor: pointer"><span id="t">Open</span></div>',
    ],
    ['an element with an interactive role', '<div id="t" role="menuitem">Open</div>'],
  ])('does not warn on %s', async (_label, html) => {
    document.body.innerHTML = html;

    const r = await executeAction(refOf('#t'), 'click');

    expect(r.warning).toBeUndefined();
  });

  it('does not warn on a non-click action aimed at a plain element', async () => {
    // Hovering or scrolling a wrapper is a legitimate thing to do; only a click means "a control".
    document.body.innerHTML = '<div id="t">Section</div>';

    const r = await executeAction(refOf('#t'), 'hover');

    expect(r.warning).toBeUndefined();
  });
});
