import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE } from '@reticlehq/protocol';
import { buildSnapshot } from './snapshot.js';
import { describe as describeElement, getValue } from './a11y.js';

describe('sensitive form values', () => {
  it('redacts password values from descriptors and snapshots', () => {
    document.body.innerHTML = '<label>Password <input type="password" value="supersecret"></label>';
    const input = document.querySelector('input') as HTMLInputElement;
    expect(getValue(input)).toBe(REDACTED_VALUE);
    expect(describeElement(input).value).toBe(REDACTED_VALUE);
    const snapshot = buildSnapshot();
    expect(snapshot.tree).toContain(`[value="${REDACTED_VALUE}"]`);
    expect(snapshot.tree).not.toContain('supersecret');
  });

  it('redacts values identified by autocomplete and field names', () => {
    document.body.innerHTML = `
      <input autocomplete="cc-number" value="4242424242424242">
      <textarea name="api_token">token-value</textarea>
    `;
    const fields = [...document.querySelectorAll('input, textarea')];
    expect(fields.map(getValue)).toEqual([REDACTED_VALUE, REDACTED_VALUE]);
  });
});
