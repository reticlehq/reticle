/**
 * A session journal is app data, and it was landing in the user's `git status`.
 *
 * `.reticle/` is a mixed directory on purpose: `contract.json`, `flows/` and `baselines/` are meant
 * to be committed — that is the whole point of a git-checked flow — while `sessions/`, `ambient.json`
 * and the rest are churning local state. This repo ignores the whole directory in its own
 * `.gitignore`, so nobody working on Reticle ever sees what a user sees: after one drive, a pile of
 * untracked files, and a `git add -A` away from committing session journals into a shared repo.
 *
 * Those journals carry URLs, request and response bodies, and DOM text from the app under test. The
 * cost of committing them by accident is not tidiness.
 *
 * So Reticle writes the ignore for the half it owns, and only that half. It never touches the
 * project's own `.gitignore` — a tool that edits a file it did not create has to be right every
 * time, and this one does not need to be: a `.gitignore` INSIDE `.reticle/` covers exactly the
 * directory Reticle already owns outright.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { createNodeFileSystem } from '../project/fs-port.js';
import { ensureWorkspaceGitignore } from './workspace-gitignore.js';

let dir = '';
let root = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reticle-wsignore-'));
  root = join(dir, ReticleDir.ROOT);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readIgnore = (): string => readFileSync(join(root, '.gitignore'), 'utf8');

describe('the workspace gitignore', () => {
  it('writes one, creating the directory if it is not there yet', async () => {
    await ensureWorkspaceGitignore(createNodeFileSystem(), root);
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
  });

  it('ignores the churning state, which is what leaks app data', async () => {
    await ensureWorkspaceGitignore(createNodeFileSystem(), root);
    const body = readIgnore();
    for (const transient of [
      ReticleDir.SESSIONS_SUBDIR,
      ReticleDir.RUNS_SUBDIR,
      ReticleDir.AMBIENT_FILE,
      ReticleDir.ENVELOPES_FILE,
      ReticleDir.PROJECT_FILE,
    ]) {
      expect(body, `${transient} must not be committable by accident`).toContain(transient);
    }
  });

  /**
   * The half that MUST stay committable. A rule that swallowed these would silently stop flows and
   * the capability contract from being shared, which is the opposite of what they are for — and it
   * would do it quietly, since nothing errors when a file is merely ignored.
   */
  it('leaves the git-checked half alone', async () => {
    await ensureWorkspaceGitignore(createNodeFileSystem(), root);
    const lines = readIgnore()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    for (const durable of [
      ReticleDir.CONTRACT_FILE,
      ReticleDir.FLOWS_SUBDIR,
      ReticleDir.BASELINES_SUBDIR,
      ReticleDir.CAPSULES_SUBDIR,
    ]) {
      expect(lines, `${durable} is meant to be committed`).not.toContain(durable);
      expect(lines, `${durable} is meant to be committed`).not.toContain(`${durable}/`);
    }
  });

  it('does not overwrite one the user has edited', async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'mine\n', 'utf8');
    await ensureWorkspaceGitignore(createNodeFileSystem(), root);
    expect(readIgnore()).toBe('mine\n');
  });

  it('is idempotent', async () => {
    await ensureWorkspaceGitignore(createNodeFileSystem(), root);
    const first = readIgnore();
    await ensureWorkspaceGitignore(createNodeFileSystem(), root);
    expect(readIgnore()).toBe(first);
  });

  /**
   * Best-effort by construction. This runs on the daemon's start path, and a workspace that cannot
   * be written — a read-only mount, a permissions problem — must not be the reason a daemon fails
   * to come up. Nothing about verification depends on this file existing.
   */
  it('never throws when the workspace cannot be written', async () => {
    const readOnlyish = join('/proc-does-not-exist-here', 'nope', ReticleDir.ROOT);
    await expect(
      ensureWorkspaceGitignore(createNodeFileSystem(), readOnlyish),
    ).resolves.toBeUndefined();
  });
});
