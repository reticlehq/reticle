/**
 * From a persona drive: a typed password reached the local session journal in clear — a `dom.attr`
 * event with `{ attr: "value", value: "<password>" }` on the `type=password` input, because the DOM
 * observer redacted nothing while the field observer beside it already knew the field was secret.
 */
import { describe, it, expect } from 'vitest';
import { EventType, REDACTED_VALUE } from '@reticlehq/core';
import { installDom } from './dom.js';

async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const TYPED = 'hunter2-correct-horse';

async function attrEventsAfter(html: string, change: (el: Element) => void) {
  document.body.innerHTML = html;
  const el = document.querySelector('input, textarea') as Element;
  const events: { type: EventType; data: Record<string, unknown> }[] = [];
  const teardown = installDom((type, data) => events.push({ type, data }));
  change(el);
  await flushMutations();
  teardown();
  return events;
}

describe('a secret field, seen by the DOM observer', () => {
  it('never carries a password input’s value, old or new', async () => {
    const events = await attrEventsAfter('<input type="password" value="old-secret">', (el) =>
      el.setAttribute('value', TYPED),
    );
    expect(JSON.stringify(events)).not.toContain(TYPED);
    expect(JSON.stringify(events)).not.toContain('old-secret');
    const attr = events.find((e) => e.type === EventType.DOM_ATTR);
    expect(attr?.data['value']).toBe(REDACTED_VALUE);
  });

  it('redacts a field named as a secret (one-time code, card number) the same way', async () => {
    const events = await attrEventsAfter('<input name="otp" autocomplete="one-time-code">', (el) =>
      el.setAttribute('value', TYPED),
    );
    expect(JSON.stringify(events)).not.toContain(TYPED);
  });

  it('never carries a secret textarea’s text, however it is set', async () => {
    const events = await attrEventsAfter('<textarea name="password"></textarea>', (el) => {
      el.textContent = TYPED;
    });
    expect(JSON.stringify(events)).not.toContain(TYPED);
  });

  it('still reports an ordinary field’s value', async () => {
    const events = await attrEventsAfter('<input name="email">', (el) =>
      el.setAttribute('value', 'ada@example.com'),
    );
    expect(events.find((e) => e.type === EventType.DOM_ATTR)?.data['value']).toBe(
      'ada@example.com',
    );
  });
});
