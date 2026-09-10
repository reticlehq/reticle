/**
 * A git failure must not read as "nothing changed".
 *
 * `changedFilesSince` returns `[]` on any git error, and its comment gives the reason: the CLI gate
 * "degrades to 'no changes' and the gate simply passes, never crashes CI". That is right for
 * `reticle gate --since main`, where crashing CI over a bad ref is worse than passing.
 *
 * It is wrong for `reticle_affected` and `reticle_verify_change`, because there "no changes" is not
 * a degradation — it is an ANSWER the agent acts on. A mistyped ref, a shallow clone with no
 * history, or a daemon outside the repository all produce a confident "nothing to re-verify", and
 * the agent ships. Same shape as #443: the two tools whose entire job is saying what still needs
 * checking, answering from a failure they cannot see.
 *
 * The second half is argument injection. `git diff --name-only <ref>` passes an unvalidated ref in
 * the argument position, so a ref beginning with `-` is read by git as an OPTION. `execFile` means
 * no shell is involved, so this is not command injection — but `--output=<path>` is enough to make
 * git write somewhere it was not asked to.
 *
 * Both halves were diagnosed in #582, which bundles them with seven other changes.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFilesSince } from './git-changed.js';
import { resolveChangedFiles } from '../cli/cli-flow-commands.js';

describe('changedFilesSince reports failure instead of inventing an empty diff', () => {
  it('says it FAILED when the directory is not a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-nogit-'));
    try {
      const out = await changedFilesSince('HEAD~1', dir);
      expect(out.files).toEqual([]);
      // The whole point: an empty list from a failure and an empty list from a clean tree are
      // different answers, and only this flag tells them apart.
      expect(out.failed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a ref that git would read as an option', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-nogit-'));
    try {
      const out = await changedFilesSince('--output=/tmp/reticle-pwn', dir);
      expect(out.failed).toBe(true);
      expect(out.reason).toMatch(/option|dash|-/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a real repository with a valid ref does not report failure', async () => {
    // The repo this test runs in. Guards against a fix that simply reports failure always.
    const out = await changedFilesSince('HEAD', process.cwd());
    expect(out.failed).toBe(false);
  });
});

/**
 * And the reason has to REACH the caller, or the flag is a fact nobody reads.
 *
 * `affected`'s own comment already knew about this case — "a git ref that resolved to nothing …
 * the question could not be answered, and re-running nothing on that basis is how a regression
 * ships" — and then folded it into "nothing changed against that input", because nothing told it
 * which had happened. It can tell now.
 */
describe('resolveChangedFiles carries the failure to its caller', () => {
  it('reports a git failure rather than an empty diff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-nogit-'));
    try {
      const out = await resolveChangedFiles([], 'HEAD~1', dir);
      expect(out.files).toEqual([]);
      expect(out.failed).toBe(true);
      expect(out.reason).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not consult git at all when no `since` was given', async () => {
    // No ref means no question was asked, which is not a failure to answer one.
    const out = await resolveChangedFiles(['a.ts'], undefined, '/nonexistent');
    expect(out.files).toEqual(['a.ts']);
    expect(out.failed).toBe(false);
  });
});
