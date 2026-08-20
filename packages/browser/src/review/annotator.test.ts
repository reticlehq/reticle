import { afterEach, describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import { Annotator } from './annotator.js';
import { asSyntheticInput } from '../actions/synthetic-input.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

let current: Annotator | undefined;

function hudEl(): HTMLElement {
  const hud = document.createElement('div');
  hud.setAttribute('data-reticle-overlay', '');
  hud.innerHTML = '<button type="button" data-reticle-chat-toggle>Chat</button>';
  document.body.appendChild(hud);
  return hud;
}

function setup(): { ann: Annotator; emits: Emitted[]; hud: HTMLElement } {
  const emits: Emitted[] = [];
  const ann = new Annotator({ emit: (type, data) => emits.push({ type, data }), now: () => 0 });
  ann.mount();
  const hud = hudEl();
  current = ann;
  return { ann, emits, hud };
}

function clickAt(el: Element, x = 100, y = 120): void {
  el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}

function popover(): HTMLElement {
  const pop = document.querySelector<HTMLElement>('[data-reticle-mark="pop"]');
  if (null === pop) throw new Error('no popover open');
  return pop;
}

function pageButton(html = '<button data-testid="cta">Pay</button>'): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  const el = host.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('no page control');
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  current?.destroy();
  current = undefined;
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('data-reticle-mark-active');
});

describe('Annotator - human marks a mistake on the page', () => {
  it('does nothing on a click while inactive', () => {
    const { ann, emits } = setup();
    clickAt(pageButton());
    expect(ann.active).toBe(false);
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
    expect(emits).toHaveLength(0);
  });

  it('toggles annotate mode on and flags the html element for the crosshair cursor', () => {
    const { ann } = setup();
    ann.toggle(true);
    expect(ann.active).toBe(true);
    expect(document.documentElement.getAttribute('data-reticle-mark-active')).toBe('1');
  });

  it('applies the HUD marker accent onto the annotator root', () => {
    const { ann } = setup();
    ann.setAccent('#06b6d4');
    const root = document.querySelector<HTMLElement>('[data-reticle-mark="root"]');
    expect(root?.style.getPropertyValue('--reticle-mark-accent')).toBe('#06b6d4');
  });

  it('click → type → send emits a HUMAN_MARK with anchor, label, source, and route', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    clickAt(
      pageButton(
        '<button data-testid="checkout" data-reticle-source="src/Checkout.tsx:42:8">Pay</button>',
      ),
    );

    const textarea = popover().querySelector('textarea');
    if (null === textarea) throw new Error('no textarea');
    textarea.value = 'This button is misaligned';
    textarea.dispatchEvent(new Event('input'));
    popover().querySelector<HTMLButtonElement>('button[data-send]')?.click();

    expect(emits).toHaveLength(1);
    expect(emits[0]?.type).toBe(EventType.HUMAN_MARK);
    const d = emits[0]?.data;
    expect(d?.['note']).toBe('This button is misaligned');
    expect(d?.['anchor']).toBe('checkout');
    expect(d?.['source']).toEqual({ file: 'src/Checkout.tsx', line: 42 });
    expect(typeof d?.['route']).toBe('string');
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
    expect(ann.markCount).toBe(1);
    expect(document.querySelector('[data-reticle-mark="pin"] span')?.textContent).toBe('1');
  });

  it('calls onMark so the SDK can echo the flag into the live panel', () => {
    const echoes: { note: string; label: string }[] = [];
    const ann = new Annotator({
      emit: () => undefined,
      now: () => 0,
      onMark: (mark) => echoes.push({ note: mark.note, label: mark.label }),
    });
    ann.mount();
    current = ann;
    ann.toggle(true);
    clickAt(pageButton());
    const textarea = popover().querySelector('textarea');
    if (null === textarea) throw new Error('no textarea');
    textarea.value = 'wrong color';
    textarea.dispatchEvent(new Event('input'));
    popover().querySelector<HTMLButtonElement>('button[data-send]')?.click();
    expect(echoes).toEqual([{ note: 'wrong color', label: 'button "Pay"' }]);
  });

  it('the send button stays disabled until the note is non-empty', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    clickAt(pageButton('<button>Go</button>'));
    const send = popover().querySelector<HTMLButtonElement>('button[data-send]');
    expect(send?.disabled).toBe(true);
    expect(emits).toHaveLength(0);
  });

  it('Enter in the note sends the mark', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    clickAt(pageButton());
    const textarea = popover().querySelector('textarea');
    if (null === textarea) throw new Error('no textarea');
    textarea.value = 'misaligned';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(emits).toHaveLength(1);
    expect(emits[0]?.data['note']).toBe('misaligned');
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
  });

  it('⌘/Ctrl+Enter in the note sends the mark', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    clickAt(pageButton());
    const textarea = popover().querySelector('textarea');
    if (null === textarea) throw new Error('no textarea');
    textarea.value = 'misaligned';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(emits).toHaveLength(1);
    expect(emits[0]?.data['note']).toBe('misaligned');
  });

  it('Enter does nothing while the note is empty', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    clickAt(pageButton('<button>Go</button>'));
    const textarea = popover().querySelector('textarea');
    textarea?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(emits).toHaveLength(0);
    expect(document.querySelector('[data-reticle-mark="pop"]')).not.toBeNull();
  });

  it('Escape closes an open popover; Escape again exits annotate mode', () => {
    const { ann } = setup();
    ann.toggle(true);
    clickAt(pageButton('<button>Go</button>'));
    expect(document.querySelector('[data-reticle-mark="pop"]')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
    expect(ann.active).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(ann.active).toBe(false);
  });

  it('cancel closes the popover without emitting', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    clickAt(pageButton('<a href="#x">link</a>'));
    popover().querySelector<HTMLButtonElement>('button[data-cancel]')?.click();
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
    expect(emits).toHaveLength(0);
  });

  const restForHighlight = (): Promise<void> => new Promise((r) => setTimeout(r, 170));

  it('hover highlight boxes the element under the cursor (with a label) once it rests', async () => {
    const { ann } = setup();
    ann.toggle(true);
    const btn = pageButton('<button data-testid="cta">Pay now</button>');
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 30 }) as DOMRect;
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const hi = document.querySelector<HTMLElement>('[data-reticle-mark="hi"]');
    expect(hi?.getAttribute('data-on')).not.toBe('1');
    await restForHighlight();
    expect(hi?.getAttribute('data-on')).toBe('1');
    expect(hi?.style.width).toBe('100px');
    expect(hi?.style.left).toBe('10px');
    expect(hi?.querySelector('[data-reticle-mark="hilabel"]')?.textContent).toBe('cta');
  });

  it('hover highlight stays off when inactive and hides over Reticle UI', async () => {
    const { ann, hud } = setup();
    const btn = pageButton('<button>Go</button>');
    btn.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 20 }) as DOMRect;
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await restForHighlight();
    expect(document.querySelector('[data-reticle-mark="hi"]')?.getAttribute('data-on')).toBe('0');
    ann.toggle(true);
    hud.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await restForHighlight();
    expect(document.querySelector('[data-reticle-mark="hi"]')?.getAttribute('data-on')).toBe('0');
  });

  it('never turns a click on the HUD into a mark', () => {
    const { ann, emits, hud } = setup();
    ann.toggle(true);
    hud.querySelector('button')?.click();
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
    expect(emits).toHaveLength(0);
    expect(ann.active).toBe(true);
  });

  it('keeps a numbered pin after submit and reopens it for edit', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    clickAt(pageButton('<button data-testid="save">Save</button>'));
    const textarea = popover().querySelector('textarea');
    if (null === textarea) throw new Error('no textarea');
    textarea.value = 'too small';
    textarea.dispatchEvent(new Event('input'));
    popover().querySelector<HTMLButtonElement>('button[data-send]')?.click();
    const pin = document.querySelector<HTMLElement>('[data-reticle-mark="pin"]');
    expect(pin?.querySelector('span')?.textContent).toBe('1');
    pin?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover().querySelector('textarea')?.value).toBe('too small');
    const again = popover().querySelector('textarea');
    if (null === again) throw new Error('no textarea');
    again.value = 'still too small';
    again.dispatchEvent(new Event('input'));
    popover().querySelector<HTMLButtonElement>('button[data-send]')?.click();
    expect(ann.markCount).toBe(1);
    expect(emits).toHaveLength(2);
    expect(emits[1]?.data['note']).toBe('still too small');
  });

  it('does not open a second pending mark on the same element', () => {
    const { ann } = setup();
    ann.toggle(true);
    const btn = pageButton('<button data-testid="once">Once</button>');
    clickAt(btn);
    clickAt(btn, 110, 130);
    expect(document.querySelectorAll('[data-reticle-mark="pop"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-reticle-mark="pending"]')).toHaveLength(1);
    expect(popover().classList.contains('reticle-mark-shake')).toBe(true);
  });

  it('hides pins when markers are toggled off', () => {
    const { ann } = setup();
    const markersBtn = document.createElement('button');
    markersBtn.setAttribute('data-reticle-markers-btn', '');
    document.body.appendChild(markersBtn);
    ann.attachChrome({ markersBtn });
    ann.toggle(true);
    clickAt(pageButton('<button data-testid="x">X</button>'));
    const textarea = popover().querySelector('textarea');
    if (null === textarea) throw new Error('no textarea');
    textarea.value = 'note';
    textarea.dispatchEvent(new Event('input'));
    popover().querySelector<HTMLButtonElement>('button[data-send]')?.click();
    expect(
      document.querySelector('[data-reticle-mark="root"]')?.getAttribute('data-hide'),
    ).toBeNull();
    markersBtn.click();
    expect(document.querySelector('[data-reticle-mark="root"]')?.getAttribute('data-hide')).toBe(
      '1',
    );
  });

  it('marks a pin stale when its element disappears', () => {
    const { ann } = setup();
    ann.toggle(true);
    const btn = pageButton('<button data-testid="gone">Gone</button>');
    clickAt(btn);
    const textarea = popover().querySelector('textarea');
    if (null === textarea) throw new Error('no textarea');
    textarea.value = 'vanished';
    textarea.dispatchEvent(new Event('input'));
    popover().querySelector<HTMLButtonElement>('button[data-send]')?.click();
    btn.remove();
    ann.syncAnchors();
    expect(document.querySelector('[data-reticle-mark="pin"]')?.getAttribute('data-stale')).toBe(
      '1',
    );
  });

  it('clicking outside a pending popover shakes it instead of dismissing', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    clickAt(pageButton('<button data-testid="keep">Keep</button>'));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('[data-reticle-mark="pop"]')).not.toBeNull();
    expect(popover().classList.contains('reticle-mark-shake')).toBe(true);
    expect(emits).toHaveLength(0);
  });
});

/**
 * Annotation is a HUMAN gesture, so it must not eat the agent's clicks.
 *
 * The capture-phase handler preventDefault()s every click while annotate mode is live, and mode is
 * live whenever the HUD is expanded. That includes clicks Reticle itself dispatched for
 * `reticle_act`, so an agent driving an app with the HUD open had every click swallowed.
 *
 * Measured against this repo's own fixture, same app and same call on both sides: on the old HUD the
 * Sign in button reported cursor `pointer` and produced `POST /api/login -> 200`; on the new one it
 * reported `crosshair` and produced no network at all, while `reticle_act` still answered
 * dispatched:true, settled:true. Reticle reporting success for an action the app never received is
 * the exact failure this product exists to catch, occurring in its own UI.
 *
 * `isTrusted` is the distinction the platform already draws: false for anything dispatchEvent
 * created, true for real user input. A real click still annotates; a synthesised one goes to the app.
 */
describe("annotate mode does not swallow the agent's clicks", () => {
  it('lets a click Reticle dispatched through to the page', () => {
    const { ann } = setup();
    const target = document.createElement('button');
    document.body.appendChild(target);
    ann.toggle(true);
    let received = 0;
    target.addEventListener('click', () => (received += 1));
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    asSyntheticInput(() => target.dispatchEvent(ev));
    expect(ev.defaultPrevented, 'the agent click must not be cancelled').toBe(false);
    expect(received, 'the page must still receive it').toBe(1);
    ann.toggle(false);
  });

  it('still captures an ordinary click for annotation', () => {
    const { ann } = setup();
    const target = document.createElement('button');
    document.body.appendChild(target);
    ann.toggle(true);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented, "a person's click is still captured").toBe(true);
    ann.toggle(false);
  });

  it('clears the mark even if a listener throws, or annotation dies for the page lifetime', () => {
    const { ann } = setup();
    const target = document.createElement('button');
    document.body.appendChild(target);
    ann.toggle(true);
    expect(() =>
      asSyntheticInput(() => {
        throw new Error('handler blew up');
      }),
    ).toThrow('handler blew up');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'annotation must still work after a throw').toBe(true);
    ann.toggle(false);
  });
});

/**
 * The note has to open ON the thing it annotates, at the time it is opened.
 *
 * The popover is `position:fixed`, so it is placed in VIEWPORT coordinates, while a mark stores the
 * viewport coordinates of the click that created it. Those two agree exactly once — before the page
 * scrolls. Reopening a mark after scrolling replayed the old numbers, so the note appeared further
 * from its element the further you had scrolled, and an open note stayed where it was while the page
 * moved under it, because scroll repositioned the pins and not the popover.
 *
 * Both paths now read the element's live box, and fall back to the stored point only when the
 * element is gone — where there is nothing better and the mark is already shown as stale.
 */
describe('the popover opens on its element, not where the page used to be', () => {
  const at = (el: HTMLElement, box: { left: number; top: number }): void => {
    el.getBoundingClientRect = (): DOMRect => ({
      left: box.left,
      top: box.top,
      width: 100,
      height: 20,
      right: box.left + 100,
      bottom: box.top + 20,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    });
  };
  const popEl = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-reticle-mark="pop"]');

  it('reopens over the element after the page has scrolled', () => {
    const { ann } = setup();
    const target = document.createElement('button');
    target.textContent = 'Press me';
    document.body.appendChild(target);
    at(target, { left: 500, top: 290 });
    ann.toggle(true);

    target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 550, clientY: 300 }),
    );
    const ta = popEl()?.querySelector('textarea');
    if (ta !== null && ta !== undefined) {
      ta.value = 'a note';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    popEl()?.querySelector<HTMLButtonElement>('button[data-send]')?.click();

    // The page scrolls; the element is now higher up the viewport.
    at(target, { left: 500, top: 90 });
    target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 550, clientY: 100 }),
    );
    const top = Number.parseFloat(popEl()?.style.top ?? 'NaN');
    expect(top, 'the note must follow the element, not the old click').toBeLessThan(200);
    ann.toggle(false);
  });

  it('keeps an open note on its element while the page scrolls under it', () => {
    const { ann } = setup();
    const target = document.createElement('button');
    target.textContent = 'Press me';
    document.body.appendChild(target);
    at(target, { left: 500, top: 400 });
    ann.toggle(true);
    target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 550, clientY: 410 }),
    );
    const ta2 = popEl()?.querySelector('textarea');
    if (ta2 !== null && ta2 !== undefined) {
      ta2.value = 'n';
      ta2.dispatchEvent(new Event('input', { bubbles: true }));
    }
    popEl()?.querySelector<HTMLButtonElement>('button[data-send]')?.click();
    target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 550, clientY: 410 }),
    );
    const before = Number.parseFloat(popEl()?.style.top ?? 'NaN');
    at(target, { left: 500, top: 120 });
    window.dispatchEvent(new Event('scroll'));
    const after = Number.parseFloat(popEl()?.style.top ?? 'NaN');
    expect(after, 'the open note tracks the scroll').toBeLessThan(before);
    ann.toggle(false);
  });
});

/**
 * The shield annotate mode raises must not be the reason annotate mode does nothing.
 *
 * `blockPageInteractions` is on by default and puts a full-viewport `position:fixed; inset:0;
 * pointer-events:auto` blocker over the page WHILE annotating. So every click while the mode is on
 * lands on that blocker, the blocker is Reticle's own UI, and the handler discarded it as such. The
 * mode was live, the cursor was a crosshair, and no click ever produced a mark.
 *
 * jsdom does no hit-testing, so every existing test clicks the element directly and passes — the
 * failure only exists where there is a real compositor. `elementsFromPoint` is stubbed here to model
 * the stack a browser would report: blocker on top, page element beneath.
 */
describe('a click on the page blocker still annotates what is under it', () => {
  it('resolves the element beneath the blocker', () => {
    const { ann } = setup();
    const target = document.createElement('button');
    target.textContent = 'Underneath';
    document.body.appendChild(target);
    const blocker = document.createElement('div');
    blocker.setAttribute('data-reticle-blocker', '');
    document.body.appendChild(blocker);
    ann.toggle(true);

    // jsdom does not implement elementsFromPoint at all, so this reads undefined and is restored
    // as undefined. Reflect rather than a direct read: the method is never called off `document`
    // here, and reading it plainly trips the unbound-method rule.
    const original: unknown = Reflect.get(document, 'elementsFromPoint');
    document.elementsFromPoint = (): Element[] => [blocker, target];
    try {
      blocker.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      );
      const pop = document.querySelector('[data-reticle-mark="pop"]');
      expect(pop, 'a click through the blocker must open the note').not.toBeNull();
      expect(pop?.textContent ?? '').toContain('Underneath');
    } finally {
      Reflect.set(document, 'elementsFromPoint', original);
      ann.toggle(false);
    }
  });

  it('drops the click when only Reticle UI is under the pointer', () => {
    const { ann } = setup();
    const blocker = document.createElement('div');
    blocker.setAttribute('data-reticle-blocker', '');
    document.body.appendChild(blocker);
    const hud = document.createElement('div');
    hud.setAttribute('data-reticle-overlay', '');
    document.body.appendChild(hud);
    ann.toggle(true);
    // jsdom does not implement elementsFromPoint at all, so this reads undefined and is restored
    // as undefined. Reflect rather than a direct read: the method is never called off `document`
    // here, and reading it plainly trips the unbound-method rule.
    const original: unknown = Reflect.get(document, 'elementsFromPoint');
    document.elementsFromPoint = (): Element[] => [blocker, hud];
    try {
      blocker.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
      expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
    } finally {
      Reflect.set(document, 'elementsFromPoint', original);
      ann.toggle(false);
    }
  });
});

/**
 * The hover outline is how a person knows WHAT they are about to mark.
 *
 * `#handleClick` was taught to see past the page blocker; `#handleMove` was not, so with the shield
 * up every mousemove reported the blocker as its target, the blocker is Reticle's own UI, and the
 * outline was suppressed on every element. Annotate mode showed a crosshair over a page with no
 * indication of what the crosshair was on.
 */
describe('the hover outline follows the element under the blocker', () => {
  it('boxes the page element beneath the shield', async () => {
    const { ann } = setup();
    const target = document.createElement('button');
    target.textContent = 'Underneath';
    document.body.appendChild(target);
    target.getBoundingClientRect = (): DOMRect =>
      ({ left: 40, top: 60, width: 120, height: 30 }) as DOMRect;
    const blocker = document.createElement('div');
    blocker.setAttribute('data-reticle-blocker', '');
    document.body.appendChild(blocker);
    ann.toggle(true);
    const original: unknown = Reflect.get(document, 'elementsFromPoint');
    document.elementsFromPoint = (): Element[] => [blocker, target];
    try {
      blocker.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 70 }),
      );
      await new Promise((r) => setTimeout(r, 200));
      const hi = document.querySelector<HTMLElement>('[data-reticle-mark="hi"]');
      expect(hi?.getAttribute('data-on'), 'the outline must be shown').toBe('1');
      expect(hi?.style.left).toBe('40px');
      expect(
        document.querySelector('[data-reticle-mark="hilabel"]')?.textContent,
        'the label names the page element, not the shield',
      ).toContain('Underneath');
    } finally {
      Reflect.set(document, 'elementsFromPoint', original);
      ann.toggle(false);
    }
  });
});

/**
 * A mark's log row has to name the mark.
 *
 * It read "generic: my feedback" - the anchor's fallback label and the note, nothing else. With
 * three marks on a page there was no way to tell which row belonged to which pin: no number, no
 * element, no source. The pin on the page is numbered, so the row carries the same number, and the
 * source the anchor already resolved.
 */
describe('the mark handed to the HUD identifies itself', () => {
  it('reports the pin number, the label and the source', () => {
    const marks: { note: string; anchor: string; index: number; source?: string }[] = [];
    const ann = new Annotator({
      emit: () => {},
      now: () => 0,
      onMark: (mark) => marks.push(mark),
    });
    ann.mount();
    current = ann;
    const target = document.createElement('button');
    target.setAttribute('data-testid', 'deploy-submit');
    target.setAttribute('data-reticle-source', 'src/views/Deployments.tsx:104:8');
    document.body.appendChild(target);
    ann.toggle(true);
    clickAt(target);
    const ta = popover().querySelector('textarea');
    if (null === ta) throw new Error('no textarea');
    ta.value = 'button is dead';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    popover().querySelector<HTMLButtonElement>('button[data-send]')?.click();
    expect(marks).toHaveLength(1);
    expect(marks[0]?.index, 'the pin on the page is #1, so the row is #1').toBe(1);
    expect(marks[0]?.anchor, 'the row names the element the agent will look up').toContain(
      'deploy-submit',
    );
    expect(marks[0]?.source, 'the anchor already knows the file').toContain('Deployments.tsx');
    expect(marks[0]?.note).toBe('button is dead');
    ann.toggle(false);
  });
});
