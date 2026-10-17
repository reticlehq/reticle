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

  const settledOf = (events: Emitted[]): Emitted[] =>
    events.filter((event) => event.data[FieldChangeField.KIND] === FieldChangeKind.SETTLED);

  /**
   * #1357: the browser's own toggle always differs, so on an uncontrolled checkbox it says nothing
   * about a render. A store commit whose component never re-renders has to stay a contradiction.
   */
  it('emits no settled reading for an uncontrolled checkbox the browser toggled itself', async () => {
    const events = watch();
    const input = box();
    await executeAction(refs.refFor(input), ActionType.CHECK, {});
    expect(input.checked).toBe(true);
    expect(settledOf(events)).toHaveLength(0);
    // The raw change still goes out, and the engine does not count that as a render.
    expect(
      events.some((event) => event.data[FieldChangeField.KIND] === FieldChangeKind.CHANGE),
    ).toBe(true);
  });

  it('emits a settled checkbox reading when the app writes checked during the action', async () => {
    const events = watch();
    const input = box();
    input.addEventListener('change', () => {
      // What a controlled component's commit does: React assigns the property.
      input.checked = true;
    });
    await executeAction(refs.refFor(input), ActionType.CHECK, {});
    const settled = settledOf(events);
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
    expect(settledOf(events)).toHaveLength(0);
  });

  it('emits no settled value for an uncontrolled text field that only holds what was filled', async () => {
    const events = watch();
    const input = document.createElement('input');
    input.setAttribute('data-testid', 'title');
    document.body.appendChild(input);
    await executeAction(refs.refFor(input), ActionType.FILL, { value: 'hi' });
    expect(input.value).toBe('hi');
    expect(settledOf(events)).toHaveLength(0);
  });

  it('emits a settled value when the app writes the filled text back', async () => {
    const events = watch();
    const input = document.createElement('input');
    input.setAttribute('data-testid', 'title');
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase();
    });
    document.body.appendChild(input);
    await executeAction(refs.refFor(input), ActionType.FILL, { value: 'hi' });
    const settled = settledOf(events)[0];
    expect(settled?.data[FieldChangeField.VALUE]).toBe('HI');
    expect(settled?.data[FieldChangeField.PREVIOUS]).toBe('');
  });

  it('puts back an own property descriptor the app had on the field', async () => {
    watch();
    const input = box();
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    const tracker: PropertyDescriptor = {
      configurable: true,
      get(this: HTMLInputElement) {
        return proto?.get?.call(this) as boolean;
      },
      set(this: HTMLInputElement, next: boolean) {
        proto?.set?.call(this, next);
      },
    };
    Object.defineProperty(input, 'checked', tracker);
    await executeAction(refs.refFor(input), ActionType.CHECK, {});
    const after = Object.getOwnPropertyDescriptor(input, 'checked');
    expect(after === undefined ? undefined : Reflect.get(after, 'set')).toBe(
      Reflect.get(tracker, 'set'),
    );
    expect(input.checked).toBe(true);
  });

  it('leaves no own property behind on a plain field', async () => {
    watch();
    const input = box();
    await executeAction(refs.refFor(input), ActionType.CHECK, {});
    expect(Object.getOwnPropertyDescriptor(input, 'checked')).toBeUndefined();
  });
});
