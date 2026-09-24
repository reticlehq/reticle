/**
 * The observer for the one thing a form does.
 *
 * `value` is in the DOM observer's attribute allowlist and that observer runs with
 * `attributeOldValue: true` — and it has never once fired for a React input, because React and
 * every controlled component set the PROPERTY, not the attribute. So the value was readable on
 * demand and there was no EVENT to cite, which is why "this field held its value across the
 * re-render" could not be asserted at all.
 *
 * Redaction is not a feature of this observer, it is the precondition for shipping it: a form is
 * where somebody's password, card number and address are typed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installField } from './field.js';

interface Emitted {
  type: string;
  data: Record<string, unknown>;
}

function page(html: string): { events: Emitted[]; teardown: () => void } {
  document.body.innerHTML = html;
  const events: Emitted[] = [];
  const teardown = installField((type, data) => {
    events.push({ type, data });
  });
  return { events, teardown };
}

const fire = (el: Element, name: string): void => {
  el.dispatchEvent(new Event(name, { bubbles: true }));
};

beforeEach(() => {
  vi.useFakeTimers();
});

describe('installField', () => {
  it('reports a committed change with the value and who it belongs to', () => {
    const { events } = page('<input data-testid="title" value="v3.3.0" />');
    const input = document.querySelector('input');
    if (null === input) throw new Error('no input');
    fire(input, 'change');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.FIELD_CHANGE);
    expect(events[0]?.data).toMatchObject({ field: 'title', kind: 'change', value: 'v3.3.0' });
  });

  /*
   * `input` fires per KEYSTROKE. Emitting one event each would put a typed sentence into the ledger
   * forty times and drown every other channel in the window a verdict is taken over. One event per
   * burst, carrying the value it settled on, is the same information at 1/40th the cost.
   */
  it('coalesces a burst of keystrokes into one event', () => {
    const { events } = page('<input data-testid="q" />');
    const input = document.querySelector('input');
    if (null === input) throw new Error('no input');
    for (const text of ['v', 'v3', 'v3.', 'v3.3']) {
      input.value = text;
      fire(input, 'input');
    }
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ kind: 'input', value: 'v3.3' });
  });

  it('keeps two fields apart rather than coalescing across them', () => {
    const { events } = page('<input data-testid="a" /><input data-testid="b" />');
    const [a, b] = [...document.querySelectorAll('input')];
    if (a === undefined || b === undefined) throw new Error('no inputs');
    a.value = 'one';
    fire(a, 'input');
    b.value = 'two';
    fire(b, 'input');
    vi.advanceTimersByTime(200);
    expect(events.map((e) => e.data['field'])).toEqual(['a', 'b']);
  });

  // The assertion this observer exists for: the field was cleared and nothing else said so.
  it('says a field was emptied, with a length of zero', () => {
    const { events } = page('<input data-testid="title" value="v3.3.0" />');
    const input = document.querySelector('input');
    if (null === input) throw new Error('no input');
    input.value = '';
    fire(input, 'change');
    expect(events[0]?.data).toMatchObject({ value: '', length: 0 });
  });

  describe('redaction — the precondition, not a feature', () => {
    it('never carries a password', () => {
      const { events } = page('<input type="password" data-testid="pw" value="hunter2" />');
      const input = document.querySelector('input');
      if (null === input) throw new Error('no input');
      fire(input, 'change');
      expect(events[0]?.data['value']).toBeUndefined();
      expect(events[0]?.data['redacted']).toBe(true);
      // The LENGTH still rides out: "it was wiped" is assertable without carrying anybody's secret.
      expect(events[0]?.data['length']).toBe(7);
    });

    it('never carries a field whose NAME is sensitive', () => {
      const { events } = page('<input name="cardNumber" value="4111111111111111" />');
      const input = document.querySelector('input');
      if (null === input) throw new Error('no input');
      fire(input, 'change');
      expect(events[0]?.data['value']).toBeUndefined();
      expect(events[0]?.data['redacted']).toBe(true);
    });

    it('never carries a payment autocomplete field, whatever it is called', () => {
      const { events } = page('<input autocomplete="cc-number" data-testid="pan" value="4111" />');
      const input = document.querySelector('input');
      if (null === input) throw new Error('no input');
      fire(input, 'change');
      expect(events[0]?.data['value']).toBeUndefined();
      expect(events[0]?.data['redacted']).toBe(true);
    });

    it('caps a long value rather than putting an essay on the wire', () => {
      const { events } = page('<textarea data-testid="notes"></textarea>');
      const area = document.querySelector('textarea');
      if (null === area) throw new Error('no textarea');
      area.value = 'x'.repeat(500);
      fire(area, 'change');
      expect(String(events[0]?.data['value']).length).toBeLessThan(200);
      // The real length is reported even when the value is clipped, so a cap cannot look like a wipe.
      expect(events[0]?.data['length']).toBe(500);
    });
  });

  it('ignores an event from something that is not a field', () => {
    const { events } = page('<div data-testid="not-a-field"></div>');
    const div = document.querySelector('div');
    if (null === div) throw new Error('no div');
    fire(div, 'change');
    expect(events).toHaveLength(0);
  });

  it('stops emitting once torn down, and cancels a pending burst', () => {
    const { events, teardown } = page('<input data-testid="q" />');
    const input = document.querySelector('input');
    if (null === input) throw new Error('no input');
    input.value = 'typing';
    fire(input, 'input');
    teardown();
    vi.advanceTimersByTime(500);
    fire(input, 'change');
    expect(events).toHaveLength(0);
  });
});
