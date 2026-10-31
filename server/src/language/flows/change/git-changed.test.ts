import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { changedFilesSince, parseGitFiles } from './git-changed.js';

const git = promisify(execFile);

/** A real repository with the given files committed, so `git diff` has a base to diff against. */
async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'reticle-gate-'));
  await git('git', ['init', '-b', 'main'], { cwd: dir });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await git('git', ['add', '.'], { cwd: dir });
  await git(
    'git',
    [
      '-c',
      'user.name=Reticle Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'base',
    ],
    { cwd: dir },
  );
  return dir;
}

/**
 * How long a test that builds a real repository may take.
 *
 * Generous on purpose, and a BOUND rather than a measurement: nothing here claims git is fast.
 * Each test below spawns real git processes against a real temp directory, which is milliseconds
 * on macOS and Linux and much slower on a Windows runner, where the 5s default would decide the
 * result instead of the assertion.
 */
const GIT_REPO_TIMEOUT_MS = 30_000;

describe('parseGitFiles', () => {
  it('splits, trims, and drops empty lines from git diff output', () => {
    const output = 'src/Checkout.tsx\n  src/cart.ts  \n\ncore/src/x.ts\n';
    expect(parseGitFiles(output)).toEqual(['src/Checkout.tsx', 'src/cart.ts', 'core/src/x.ts']);
  });

  it('returns an empty list for empty output', () => {
    expect(parseGitFiles('')).toEqual([]);
    expect(parseGitFiles('\n\n')).toEqual([]);
  });
});

/**
 * Reticle writes its own files during and after a replay: `.reticle/intent/index.json`,
 * `impact.json` and the raw episode files. Those writes are Reticle's output, not a change to the
 * app's code. A flow with no source stamps reads any change as "affected", so the gate counted
 * those writes and marked flows it had just proved as uncovered (#2050).
 */
describe('changedFilesSince leaves out the files Reticle itself wrote', () => {
  it(
    'keeps app files and drops the .reticle files a replay wrote',
    async () => {
      const dir = await makeRepo({
        'src/App.tsx': 'app\n',
        '.reticle/intent/index.json': '{}\n',
      });
      try {
        await writeFile(join(dir, 'src/App.tsx'), 'app changed\n');
        await writeFile(join(dir, '.reticle/intent/index.json'), '{"run":1}\n');
        const out = await changedFilesSince('HEAD', dir);
        expect(out.failed).toBe(false);
        expect(out.files).toEqual(['src/App.tsx']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    GIT_REPO_TIMEOUT_MS,
  );

  it(
    'returns an empty list when only .reticle files changed',
    async () => {
      const dir = await makeRepo({
        'src/App.tsx': 'app\n',
        '.reticle/intent/index.json': '{}\n',
        '.reticle/impact.json': '{}\n',
      });
      try {
        await writeFile(join(dir, '.reticle/intent/index.json'), '{"run":1}\n');
        await writeFile(join(dir, '.reticle/impact.json'), '{"run":1}\n');
        const out = await changedFilesSince('HEAD', dir);
        expect(out.failed).toBe(false);
        expect(out.files).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    GIT_REPO_TIMEOUT_MS,
  );

  it(
    'drops a .reticle directory below the repo root too',
    async () => {
      const dir = await makeRepo({
        'apps/web/src/App.tsx': 'app\n',
        'apps/web/.reticle/impact.json': '{}\n',
      });
      try {
        await writeFile(join(dir, 'apps/web/src/App.tsx'), 'app changed\n');
        await writeFile(join(dir, 'apps/web/.reticle/impact.json'), '{"run":1}\n');
        const out = await changedFilesSince('HEAD', dir);
        expect(out.failed).toBe(false);
        expect(out.files).toEqual(['apps/web/src/App.tsx']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    GIT_REPO_TIMEOUT_MS,
  );
});
