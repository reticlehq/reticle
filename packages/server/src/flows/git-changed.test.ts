import { describe, expect, it } from 'vitest';
import { parseGitFiles } from './git-changed.js';

describe('parseGitFiles', () => {
  it('splits, trims, and drops empty lines from git diff output', () => {
    const output = 'src/Checkout.tsx\n  src/cart.ts  \n\npackages/core/src/x.ts\n';
    expect(parseGitFiles(output)).toEqual([
      'src/Checkout.tsx',
      'src/cart.ts',
      'packages/core/src/x.ts',
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseGitFiles('')).toEqual([]);
    expect(parseGitFiles('\n\n')).toEqual([]);
  });
});
