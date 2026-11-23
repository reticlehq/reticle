/**
 * A text property over text that Reticle could not read is `unknown`, never `no` (#2277).
 *
 * An app turned on text redaction. A scoped `text` check with `self: true` and `matchesPattern` read
 * `""` for a visible table cell. The evidence for the same element showed role `cell` and the number
 * as its name. The check answered `no` about text it never saw. A body check over a redacted field
 * already answers `unknown`; a text property now does the same.
 */
import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE } from '@reticlehq/core';
import { withTextProperty } from './predicate-element.js';
import type { PropertyAssertion } from './property.js';

const DIGITS = { property: 'matchesPattern', pattern: '^\\d+$' } as unknown as PropertyAssertion;
const SUBJECT = '{"scope":"cell","self":true}';

const passingMatch = (elements: unknown[]) => ({ pass: true, evidence: elements });

describe('a text property over hidden text', () => {
  it('is unknown when the page sent the redaction marker as the text', () => {
    const result = withTextProperty(
      passingMatch([{ ref: 'e1', role: 'cell', name: '11', text: REDACTED_VALUE }]),
      DIGITS,
      SUBJECT,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toMatch(/redact/i);
  });

  it('is unknown when the text is empty and the element has a name', () => {
    const result = withTextProperty(
      passingMatch([{ ref: 'e1', role: 'cell', name: '11', text: '' }]),
      DIGITS,
      SUBJECT,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toMatch(/redact/i);
  });

  // The marker is text too: a property it satisfies must not pass on it.
  it.each([{ property: 'matchesPattern', pattern: 'RED' }, { property: 'nonEmpty' }])(
    'is unknown, not yes, for a property the marker satisfies ($property)',
    (assertion) => {
      const result = withTextProperty(
        passingMatch([{ ref: 'e1', role: 'cell', name: '11', text: REDACTED_VALUE }]),
        assertion as unknown as PropertyAssertion,
        SUBJECT,
      );
      expect(result.pass).toBe(false);
      expect(result.inconclusive).toMatch(/redact/i);
    },
  );

  it('is still yes when the text that was read satisfies the property', () => {
    const result = withTextProperty(
      passingMatch([{ ref: 'e1', role: 'cell', name: '11', text: '11' }]),
      DIGITS,
      SUBJECT,
    );
    expect(result.pass).toBe(true);
  });

  it('is still no when the text that was read does not satisfy the property', () => {
    const result = withTextProperty(
      passingMatch([{ ref: 'e1', role: 'cell', name: 'eleven', text: 'eleven' }]),
      DIGITS,
      SUBJECT,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  it('is still no for an empty element with no name: there is nothing to hide', () => {
    const result = withTextProperty(
      passingMatch([{ ref: 'e1', role: 'cell', name: '', text: '' }]),
      DIGITS,
      SUBJECT,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });
});
