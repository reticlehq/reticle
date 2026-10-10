/**
 * The settled field read is taken after the action, not from the input event.
 *
 * A controlled checkbox commits by setting the `checked` property. The change event fires from the
 * click itself, before React restores a component that did not re-render, so that event cannot be
 * what tells the contradiction rule the screen moved.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ActionType, EventType, FieldChangeField, FieldChangeKind } from '@reticlehq/core';
import { executeAction } from '@/actions/actions.js';
import { refs } from '@/dom/addressing/refs.js';
import { installField } from './field.js';

interface Emitted {
  type: string;
  data: Record<string, unknown>;
}

describe('settled field read after an action', () => {
  let teardown: () => void = () => {};

  afterEach(() => {
    teardown();
    teardown = () => {};
    document.body.innerHTML = '';
  });

  function watch(): Emitted[] {
    const events: Emitted[] = [];
    teardown = installField((type, data) => {
      events.push({ type, data });
    });
    return events;
  }

  function box(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('data-testid', 'on');
    document.body.appendChild(input);
    return input;
  }

  it('emits a settled checkbox reading when checked survives the frame', async () => {
    const events = watch();
    const input = box();
    await executeAction(refs.refFor(input), ActionType.CHECK, {});
    const settled = events.filter(
      (event) => event.data[FieldChangeField.KIND] === FieldChangeKind.SETTLED,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.type).toBe(EventType.FIELD_CHANGE);
    expect(settled[0]?.data[FieldChangeField.CHECKED]).toBe(true);
    expect(settled[0]?.data[FieldChangeField.PREVIOUS_CHECKED]).toBe(false);
  });

  it('emits no settled reading when the control is restored to its pre-action checked state', async () => {
    const events = watch();
    const input = box();
    input.addEventListener('change', () => {
      input.checked = false;
    });
    await executeAction(refs.refFor(input), ActionType.CHECK, {});
    expect(input.checked).toBe(false);
    expect(
      events.filter((event) => event.data[FieldChangeField.KIND] === FieldChangeKind.SETTLED),
    ).toHaveLength(0);
  });

  it('emits a settled value when a text field keeps what was filled', async () => {
    const events = watch();
    const input = document.createElement('input');
    input.setAttribute('data-testid', 'title');
    document.body.appendChild(input);
    await executeAction(refs.refFor(input), ActionType.FILL, { value: 'hi' });
    const settled = events.find(
      (event) => event.data[FieldChangeField.KIND] === FieldChangeKind.SETTLED,
    );
    expect(settled?.data[FieldChangeField.VALUE]).toBe('hi');
    expect(settled?.data[FieldChangeField.PREVIOUS]).toBe('');
  });
});
