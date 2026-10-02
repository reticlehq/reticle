import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '@/machine/repo-root.js';

/**
 * The release check has to be able to go red.
 *
 * A guard that has only ever been seen passing does not prove it still notices the label. The
 * self-test feeds it an open issue wearing `fixed-pending-release` and a list that is clean, and
 * fails if those two answers agree.
 */
describe('the pending-release check', () => {
  it('passes its own self-test', () => {
    const out = execFileSync('node', ['scripts/check-pending-release.mjs', '--self-test'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('pending-release check self-test passed');
  });
});
