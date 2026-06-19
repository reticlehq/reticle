import { afterEach, describe, expect, it } from 'vitest';
import { EventType } from '@syrin/iris-protocol';
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
  const pop = document.querySelector<HTMLElement>('[data-iris-mark="pop"]');
  if (pop === null) throw new Error('no popover open');
  return pop;
}

afterEach(() => {
  current?.destroy();
  current = undefined;
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('data-iris-mark-active');
});

describe('Annotator — human marks a mistake on the page', () => {
  it('does nothing on a click while inactive', () => {
    const { ann, emits } = setup();
    document.body.insertAdjacentHTML('beforeend', '<button data-testid="cta">Buy</button>');
    clickAt(document.querySelector('[data-testid="cta"]') as Element);
    expect(ann.active).toBe(false);
    expect(document.querySelector('[data-iris-mark="pop"]')).toBeNull();
    expect(emits).toHaveLength(0);
  });

  it('toggles annotate mode on and flags the html element for the crosshair cursor', () => {
    const { ann } = setup();
    ann.toggle(true);
    expect(ann.active).toBe(true);
    expect(document.documentElement.getAttribute('data-iris-mark-active')).toBe('1');
  });

  it('click → type → send emits a HUMAN_MARK with anchor, label, source, and route', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<button data-testid="checkout" data-iris-source="src/Checkout.tsx:42:8">Pay</button>',
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
    expect(document.querySelector('[data-iris-mark="pop"]')).toBeNull();
    expect(ann.markCount).toBe(1);
  });

  it('the send button stays disabled until the note is non-empty', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    document.body.insertAdjacentHTML('beforeend', '<button>Go</button>');
    clickAt(document.querySelector('button:not([data-iris-mark="fab"])') as Element);
    const send = popover().querySelector<HTMLButtonElement>('button[data-send]');
    expect(send?.disabled).toBe(true);
    expect(emits).toHaveLength(0);
  });

  it('cancel closes the popover without emitting', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    document.body.insertAdjacentHTML('beforeend', '<a href="#x">link</a>');
    clickAt(document.querySelector('a') as Element);
    popover().querySelector<HTMLButtonElement>('button[data-cancel]')?.click();
    expect(document.querySelector('[data-iris-mark="pop"]')).toBeNull();
    expect(emits).toHaveLength(0);
  });

  it('never turns a click on its own UI (the FAB) into a mark', () => {
    const { ann, emits } = setup();
    ann.toggle(true);
    document.querySelector<HTMLElement>('[data-iris-mark="fab"]')?.click();
    // The FAB click toggles mode off; it must not open a popover or emit.
    expect(document.querySelector('[data-iris-mark="pop"]')).toBeNull();
    expect(emits).toHaveLength(0);
  });
});
