import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '@/machine/repo-root.js';

/**
 * `pnpm remap:prs` used to rewrite `packages/server/` to `server/` and call the result a path.
 * Git's rename record puts `packages/server/src/events/lineage.ts` in `engine/`, so the rewritten
 * patch named a file that was never there and the script reported a conflict with nobody's work
 * (#1033). The self-test is the check: it fails if lineage goes anywhere else, or if a patch body
 * is treated as a header.
 */
describe('remap follows git renames, not the package root', () => {
  it('resolves the lineage paths from the restructure and leaves content lines alone', () => {
    const out = execFileSync(process.execPath, ['scripts/remap-stranded-prs.mjs', '--self-test'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('remap self-test passed');
  });
});
