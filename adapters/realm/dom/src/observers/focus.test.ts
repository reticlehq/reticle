import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { focusLabel, installFocus } from './focus.js';
import type { Emit } from './types.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

describe('focusLabel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('labels an interactive element by role + accessible name', () => {
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    expect(focusLabel(button)).toBe('button "Save"');
  });

  it('returns undefined for body or null', () => {
    expect(focusLabel(document.body)).toBeUndefined();
    expect(focusLabel(null)).toBeUndefined();
  });
});

describe('installFocus', () => {
  let events: Captured[];
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = '<button>Go</button>';
    events = [];
    const emit: Emit = (type, data) => events.push({ type, data });
    teardown = installFocus(emit);
  });
  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('emits FOCUS_CHANGE naming the newly focused element', () => {
    const button = document.querySelector('button') as HTMLButtonElement;
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const change = events.find((e) => e.type === EventType.FOCUS_CHANGE);
    expect(change?.data).toMatchObject({ to: 'button "Go"', toBody: false });
  });

  it('flags focus dropping to body (toBody:true) when nothing gains it', () => {
    const button = document.querySelector('button') as HTMLButtonElement;
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    events.length = 0;
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    const change = events.find((e) => e.type === EventType.FOCUS_CHANGE);
    expect(change?.data).toMatchObject({ from: 'button "Go"', toBody: true });
  });

  it('stops emitting after teardown', () => {
    teardown?.();
    teardown = undefined;
    events.length = 0;
    document.querySelector('button')?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(events).toHaveLength(0);
  });
});
