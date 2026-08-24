import { describe, expect, it } from 'vitest';
import {
  GIT_DIFF_FAILED,
  GIT_REF_LOOKS_LIKE_OPTION,
  changedFilesSince,
  isSafeGitRef,
  parseGitFiles,
} from './git-changed.js';

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

describe('isSafeGitRef', () => {
  it('accepts ordinary revision names', () => {
    expect(isSafeGitRef('main')).toBe(true);
    expect(isSafeGitRef('HEAD~3')).toBe(true);
    expect(isSafeGitRef('origin/main')).toBe(true);
  });

  it('refuses anything that git would parse as an option', () => {
    // The field report shape: --output writes a file as the daemon user.
    expect(isSafeGitRef('--output=/tmp/evil')).toBe(false);
    expect(isSafeGitRef('-u')).toBe(false);
    expect(isSafeGitRef('')).toBe(false);
  });
});

describe('changedFilesSince', () => {
  it('refuses a dash-prefixed ref before spawning git', async () => {
    await expect(
      changedFilesSince('--output=/tmp/reticle-should-not-exist', process.cwd()),
    ).rejects.toThrow(GIT_REF_LOOKS_LIKE_OPTION);
  });

  it('throws a distinct failure when git cannot produce a diff', async () => {
    await expect(
      changedFilesSince('main', 'C:\\this\\path\\is\\not\\a\\git\\repo\\reticle-audit'),
    ).rejects.toThrow(GIT_DIFF_FAILED);
  });
});
