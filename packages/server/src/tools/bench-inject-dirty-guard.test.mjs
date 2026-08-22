import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HARNESS_FILES = [
  '.gitattributes',
  'bench/harness/inject.mjs',
  'apps/bench-app/src/store/store.ts',
  'apps/bench-app/src/components/NewDeployModal.tsx',
  'apps/bench-app/src/views/Overview.tsx',
  'apps/bench-app/src/views/Diagnostics.tsx',
];
const DIRTY_TARGET = 'apps/bench-app/src/views/Overview.tsx';
const TEST_TIMEOUT_MS = 30_000;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function copyHarnessFile(root, relativePath) {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(ROOT, relativePath), destination);
}

function withHarnessRepo(run) {
  const root = mkdtempSync(join(tmpdir(), 'reticle-bench-guard-'));
  try {
    for (const file of HARNESS_FILES) copyHarnessFile(root, file);
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Reticle test');
    git(root, 'config', 'user.email', 'reticle-test@example.com');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'baseline');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function verifyAnchors(root) {
  return spawnSync(process.execPath, [join(root, 'bench/harness/inject.mjs'), '--verify-anchors'], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('benchmark injector dirty-worktree guard', () => {
  it(
    'allows a clean worktree and restores every injected fixture',
    () => {
      withHarnessRepo((root) => {
        const result = verifyAnchors(root);

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/anchors ok/i);
        expect(git(root, 'status', '--porcelain')).toBe('');
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an unstaged anchor edit without changing it',
    () => {
      withHarnessRepo((root) => {
        const target = join(root, DIRTY_TARGET);
        appendFileSync(target, '\n// local unstaged edit\n');
        const before = readFileSync(target, 'utf8');

        const result = verifyAnchors(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/refusing to run/i);
        expect(result.stderr.replaceAll('\\', '/')).toContain(DIRTY_TARGET);
        expect(readFileSync(target, 'utf8')).toBe(before);
        expect(git(root, 'diff', '--name-only').trim()).toBe(DIRTY_TARGET);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a staged anchor edit without changing it',
    () => {
      withHarnessRepo((root) => {
        const target = join(root, DIRTY_TARGET);
        appendFileSync(target, '\n// local staged edit\n');
        git(root, 'add', DIRTY_TARGET);
        const before = readFileSync(target, 'utf8');

        const result = verifyAnchors(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/refusing to run/i);
        expect(result.stderr.replaceAll('\\', '/')).toContain(DIRTY_TARGET);
        expect(readFileSync(target, 'utf8')).toBe(before);
        expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe(DIRTY_TARGET);
      });
    },
    TEST_TIMEOUT_MS,
  );
});
