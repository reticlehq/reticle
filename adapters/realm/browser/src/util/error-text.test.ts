import { describe, expect, it } from 'vitest';
import { errorText } from './error-text.js';

describe('errorText', () => {
  it('reads an Error by its message and anything else as a string', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('NEXT_REDIRECT')).toBe('NEXT_REDIRECT');
    expect(errorText(42)).toBe('42');
    expect(errorText(undefined)).toBe('undefined');
  });
});
