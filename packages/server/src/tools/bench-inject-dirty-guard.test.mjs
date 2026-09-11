import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Kept under packages/server/src so the server unit gate runs it; bench/harness is not a test target.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const INJECTOR_PATH = 'bench/harness/inject.mjs';
const COMMITTED_HARNESS_FILES = [
  '.gitattributes',
  'apps/bench-app/src/store/store.ts',
  'apps/bench-app/src/components/NewDeployModal.tsx',
  'apps/bench-app/src/views/Overview.tsx',
  'apps/bench-app/src/views/Diagnostics.tsx',
];
const DIRTY_TARGET = 'apps/bench-app/src/views/Overview.tsx';
const TEST_TIMEOUT_MS = 30_000;

function createCleanGitEnv(sandbox) {
  const home = join(sandbox, 'home');
  const globalConfig = join(home, '.gitconfig');
  mkdirSync(home, { recursive: true });
  writeFileSync(globalConfig, '');
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
  };
}

function git(root, env, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env,
  });
}

function destinationFor(root, relativePath) {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  return destination;
}

function copyWorkingTreeFile(root, relativePath) {
  copyFileSync(join(ROOT, relativePath), destinationFor(root, relativePath));
}

function copyCommittedHarnessFile(root, relativePath, env) {
  const content = execFileSync('git', ['-C', ROOT, 'show', `HEAD:${relativePath}`], {
    env,
  });
  writeFileSync(destinationFor(root, relativePath), content);
}

function withHarnessRepo(run) {
  const sandbox = mkdtempSync(join(tmpdir(), 'reticle-bench-guard-'));
  const root = join(sandbox, 'repo');
  const env = createCleanGitEnv(sandbox);
  mkdirSync(root, { recursive: true });
  try {
    // Exercise the injector being edited, but seed anchors from HEAD so a crashed bench run
    // cannot make the temp repo start from already-injected fixture content.
    copyWorkingTreeFile(root, INJECTOR_PATH);
    for (const file of COMMITTED_HARNESS_FILES) copyCommittedHarnessFile(root, file, env);
    git(root, env, 'init', '-q');
    git(root, env, 'config', 'user.name', 'Reticle test');
    git(root, env, 'config', 'user.email', 'reticle-test@example.com');
    git(root, env, 'add', '.');
    git(root, env, 'commit', '-qm', 'baseline');
    run(root, env);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function verifyAnchors(root, env) {
  return spawnSync(process.execPath, [join(root, INJECTOR_PATH), '--verify-anchors'], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

describe('benchmark injector dirty-worktree guard', () => {
  it(
    'allows a clean worktree and restores every injected fixture',
    () => {
      withHarnessRepo((root, env) => {
        const result = verifyAnchors(root, env);

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/anchors ok/i);
        expect(git(root, env, 'status', '--porcelain')).toBe('');
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an unstaged anchor edit without changing it',
    () => {
      withHarnessRepo((root, env) => {
        const target = join(root, DIRTY_TARGET);
        appendFileSync(target, '\n// local unstaged edit\n');
        const before = readFileSync(target, 'utf8');

        const result = verifyAnchors(root, env);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/refusing to run/i);
        expect(result.stderr.replaceAll('\\', '/')).toContain(DIRTY_TARGET);
        expect(readFileSync(target, 'utf8')).toBe(before);
        expect(git(root, env, 'diff', '--name-only').trim()).toBe(DIRTY_TARGET);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a staged anchor edit without changing it',
    () => {
      withHarnessRepo((root, env) => {
        const target = join(root, DIRTY_TARGET);
        appendFileSync(target, '\n// local staged edit\n');
        git(root, env, 'add', DIRTY_TARGET);
        const before = readFileSync(target, 'utf8');

        const result = verifyAnchors(root, env);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/refusing to run/i);
        expect(result.stderr.replaceAll('\\', '/')).toContain(DIRTY_TARGET);
        expect(readFileSync(target, 'utf8')).toBe(before);
        expect(git(root, env, 'diff', '--cached', '--name-only').trim()).toBe(DIRTY_TARGET);
      });
    },
    TEST_TIMEOUT_MS,
  );
});
