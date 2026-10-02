/**
 * Form fields in the causal summary.
 *
 * The observer that produces these events exists because nothing in the SDK could see a value
 * move: `value` is in the DOM observer's attribute allowlist and React sets the PROPERTY, so
 * `MutationObserver` never fired. An event nothing READS is the same gap one layer up, so the
 * summary every verdict carries names the fields that moved.
 *
 * Names, never values. A form is where somebody types their password.
 */

import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { causalSummary } from './causal-summary.js';

const fieldMoved = (field: string, over: Record<string, unknown> = {}): ReticleEvent =>
  ({
    type: EventType.FIELD_CHANGE,
    t: 1,
    data: { field, kind: 'change', length: 3, value: 'abc', ...over },
  }) as unknown as ReticleEvent;

describe('causalSummary — fields', () => {
  it('names each field that moved, once', () => {
    const summary = causalSummary([fieldMoved('title'), fieldMoved('title'), fieldMoved('body')]);
    expect(summary.fieldsChanged).toEqual(['title', 'body']);
  });

  // Absent, not empty: a page with no form pays nothing and says nothing.
  it('says nothing when no field moved', () => {
    expect(causalSummary([]).fieldsChanged).toBeUndefined();
  });

  // The redacted case still counts: WHICH field moved is not a secret, only what is in it.
  it('still names a redacted field', () => {
    const summary = causalSummary([
      fieldMoved('password', { value: undefined, redacted: true, length: 7 }),
    ]);
    expect(summary.fieldsChanged).toEqual(['password']);
  });

  it('never carries a value into the summary', () => {
    const summary = causalSummary([fieldMoved('card', { value: '4111111111111111' })]);
    expect(JSON.stringify(summary)).not.toContain('4111');
  });
});
