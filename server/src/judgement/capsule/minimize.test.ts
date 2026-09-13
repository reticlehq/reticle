import { describe, expect, it } from 'vitest';
import { prefixTrim } from './minimize.js';

describe('prefixTrim', () => {
  it('drops leading setup steps, keeping the minimal failing suffix', async () => {
    const steps = ['login', 'browse', 'addToCart', 'submit'];
    // The bug reproduces as long as `submit` is still in the flow.
    const stillFails = (c: readonly string[]): Promise<boolean> =>
      Promise.resolve(c.includes('submit'));
    expect(await prefixTrim(steps, stillFails)).toEqual(['submit']);
  });

  it('keeps steps that are load-bearing for the failure', async () => {
    const steps = ['login', 'addToCart', 'submit'];
    // Needs BOTH addToCart and submit to fail (an empty cart submit does not).
    const stillFails = (c: readonly string[]): Promise<boolean> =>
      Promise.resolve(c.includes('addToCart') && c.includes('submit'));
    expect(await prefixTrim(steps, stillFails)).toEqual(['addToCart', 'submit']);
  });

  it('never trims below one step', async () => {
    const stillFails = (): Promise<boolean> => Promise.resolve(true);
    expect(await prefixTrim(['only'], stillFails)).toEqual(['only']);
  });

  it('returns the full flow when no prefix can be removed', async () => {
    const steps = ['a', 'b'];
    const stillFails = (c: readonly string[]): Promise<boolean> => Promise.resolve(c.includes('a'));
    expect(await prefixTrim(steps, stillFails)).toEqual(['a', 'b']);
  });
});
