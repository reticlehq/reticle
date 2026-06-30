import { afterEach, describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/protocol';
import { Annotator } from './annotator.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

let current: Annotator | undefined;

function setup(): { ann: Annotator; emits: Emitted[] } {
  const emits: Emitted[] = [];
  const ann = new Annotator({ emit: (type, data) => emits.push({ type, data }), now: () => 0 });
  ann.mount();
  current = ann; // tracked so afterEach tears down its document-level capture listener (no leak across tests)
  return { ann, emits };
}

function clickAt(el: Element, x = 100, y = 120): void {
  el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}

function popover(): HTMLElement {
  const pop = document.querySelector<HTMLElement>('[data-reticle-mark="pop"]');
  if (pop === null) throw new Error('no popover open');
  return pop;
}

afterEach(() => {
  current?.destroy();
  current = undefined;
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('data-reticle-mark-active');
});

describe('Annotator — human marks a mistake on the page', () => {
  it('does nothing on a click while inactive', () => {
    const { ann, emits } = setup();
    document.body.insertAdjacentHTML('beforeend', '<button data-testid="cta">Buy</button>');
    clickAt(document.querySelector('[data-testid="cta"]') as Element);
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

  it('click → type → send emits a HUMAN_MARK with anchor, label, source, and route', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<button data-testid="checkout" data-reticle-source="src/Checkout.tsx:42:8">Pay</button>',
    );
    clickAt(document.querySelector('[data-testid="checkout"]') as Element);

    const textarea = popover().querySelector('textarea');
    if (textarea === null) throw new Error('no textarea');
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
    // The popover closes and a numbered pin confirms the mark landed.
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
    expect(ann.markCount).toBe(1);
  });

  it('calls onMark so the SDK can echo the flag into the live panel', () => {
    const echoes: { note: string; label: string }[] = [];
    const ann = new Annotator({
      emit: () => undefined,
      now: () => 0,
      onMark: (note, label) => echoes.push({ note, label }),
    });
    ann.mount();
    current = ann;
    ann.toggle(true);
    document.body.insertAdjacentHTML('beforeend', '<button data-testid="cta">Pay</button>');
    clickAt(document.querySelector('[data-testid="cta"]') as Element);
    const textarea = popover().querySelector('textarea');
    if (textarea === null) throw new Error('no textarea');
    textarea.value = 'wrong color';
    textarea.dispatchEvent(new Event('input'));
    popover().querySelector<HTMLButtonElement>('button[data-send]')?.click();
    expect(echoes).toEqual([{ note: 'wrong color', label: 'button "Pay"' }]);
  });

  it('the send button stays disabled until the note is non-empty', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    document.body.insertAdjacentHTML('beforeend', '<button>Go</button>');
    clickAt(document.querySelector('button:not([data-reticle-mark="fab"])') as Element);
    const send = popover().querySelector<HTMLButtonElement>('button[data-send]');
    expect(send?.disabled).toBe(true);
    expect(emits).toHaveLength(0);
  });

  it('⌘/Ctrl+Enter in the note sends the mark', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    document.body.insertAdjacentHTML('beforeend', '<button data-testid="cta">Pay</button>');
    clickAt(document.querySelector('[data-testid="cta"]') as Element);
    const textarea = popover().querySelector('textarea');
    if (textarea === null) throw new Error('no textarea');
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
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
  });

  it('⌘/Ctrl+Enter does nothing while the note is empty', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    document.body.insertAdjacentHTML('beforeend', '<button>Go</button>');
    clickAt(document.querySelector('button:not([data-reticle-mark="fab"])') as Element);
    const textarea = popover().querySelector('textarea');
    textarea?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(emits).toHaveLength(0);
    expect(document.querySelector('[data-reticle-mark="pop"]')).not.toBeNull();
  });

  it('Escape closes an open popover; Escape again exits annotate mode', () => {
    const { ann } = setup();
    ann.toggle(true);
    document.body.insertAdjacentHTML('beforeend', '<button>Go</button>');
    clickAt(document.querySelector('button:not([data-reticle-mark="fab"])') as Element);
    expect(document.querySelector('[data-reticle-mark="pop"]')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
    expect(ann.active).toBe(true); // still in annotate mode, just closed the popover
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(ann.active).toBe(false); // a second Escape leaves annotate mode
  });

  it('cancel closes the popover without emitting', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    document.body.insertAdjacentHTML('beforeend', '<a href="#x">link</a>');
    clickAt(document.querySelector('a') as Element);
    popover().querySelector<HTMLButtonElement>('button[data-cancel]')?.click();
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
    expect(emits).toHaveLength(0);
  });

  // The outline is debounced — it boxes the element only after the cursor rests (HIGHLIGHT_REST_MS),
  // so a fast sweep across the page never flickers. Tests wait past that rest before asserting.
  const restForHighlight = (): Promise<void> => new Promise((r) => setTimeout(r, 170));

  it('hover highlight boxes the element under the cursor (with a label) once it rests', async () => {
    const { ann } = setup();
    ann.toggle(true);
    document.body.insertAdjacentHTML('beforeend', '<button data-testid="cta">Pay now</button>');
    const btn = document.querySelector('[data-testid="cta"]') as HTMLElement;
    // jsdom has no layout, so fake the rect the highlight positions over.
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 30 }) as DOMRect;
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const hi = document.querySelector<HTMLElement>('[data-reticle-mark="hi"]');
    expect(hi?.getAttribute('data-on')).not.toBe('1'); // still travelling — not yet
    await restForHighlight();
    expect(hi?.getAttribute('data-on')).toBe('1');
    expect(hi?.style.width).toBe('100px');
    expect(hi?.style.left).toBe('10px');
    expect(hi?.querySelector('[data-reticle-mark="hilabel"]')?.textContent).toBe('cta'); // testid wins
  });

  it('hover highlight stays off when inactive and hides over its own UI', async () => {
    const { ann } = setup();
    document.body.insertAdjacentHTML('beforeend', '<button>Go</button>');
    const btn = document.querySelector('button:not([data-reticle-mark="fab"])') as HTMLElement;
    btn.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 20 }) as DOMRect;
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); // inactive
    await restForHighlight();
    expect(document.querySelector('[data-reticle-mark="hi"]')?.getAttribute('data-on')).toBe('0');
    // active, but moving over the FAB (our own UI) → still off
    ann.toggle(true);
    document
      .querySelector('[data-reticle-mark="fab"]')
      ?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await restForHighlight();
    expect(document.querySelector('[data-reticle-mark="hi"]')?.getAttribute('data-on')).toBe('0');
  });

  it('never turns a click on its own UI (the FAB) into a mark', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    document.querySelector<HTMLElement>('[data-reticle-mark="fab"]')?.click();
    // The FAB click toggles mode off; it must not open a popover or emit.
    expect(document.querySelector('[data-reticle-mark="pop"]')).toBeNull();
    expect(emits).toHaveLength(0);
  });
});
