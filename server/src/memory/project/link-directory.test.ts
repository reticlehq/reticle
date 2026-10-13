/**
 * `reticle link` wrote `cwd/.reticle/cloud.json`, while a session's runs go to the root the artifact
 * resolver picks for its project. Linking a monorepo from its root left `apps/web/.reticle` — where
 * every run of that app landed — unlinked, and the daemon skipped it on every cycle.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverProjectConfigs } from '@/command/cli/config/config-discovery.js';
import { callerArtifactRoot, linkDirectoryFor } from './link-directory.js';

let root = '';

const config = (relative: string, projectId: string): void => {
  mkdirSync(join(root, relative), { recursive: true });
  writeFileSync(join(root, relative, '.reticle.json'), JSON.stringify({ projectId }));
};
const linkDir = (cwd: string): string => linkDirectoryFor(cwd, discoverProjectConfigs(cwd));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reticle-link-dir-'));
  mkdirSync(join(root, '.git'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('linkDirectoryFor', () => {
  it('links the one app a monorepo root holds, where its runs are written', () => {
    config('apps/web', 'web-1');
    expect(linkDir(root)).toBe(join(root, 'apps/web'));
  });

  it('links the project the directory itself declares', () => {
    config('.', 'root-1');
    config('apps/web', 'web-1');
    expect(linkDir(root)).toBe(root);
  });

  it('links the enclosing project from a folder inside it', () => {
    config('apps/web', 'web-1');
    mkdirSync(join(root, 'apps/web/src'), { recursive: true });
    expect(linkDir(join(root, 'apps/web/src'))).toBe(join(root, 'apps/web'));
  });

  it('keeps the directory itself when several apps could be meant', () => {
    config('apps/web', 'web-1');
    config('apps/admin', 'admin-1');
    expect(linkDir(root)).toBe(root);
  });

  it('keeps the directory itself when no project is declared anywhere', () => {
    expect(linkDir(root)).toBe(root);
  });
});

describe('callerArtifactRoot', () => {
  it('names the enclosing project’s .reticle', () => {
    config('apps/web', 'web-1');
    expect(callerArtifactRoot(join(root, 'apps/web'))).toBe(join(root, 'apps/web/.reticle'));
  });

  it('names nothing in a folder that is no project, so nothing is planted there', () => {
    mkdirSync(join(root, 'notes'));
    expect(callerArtifactRoot(join(root, 'notes'))).toBeUndefined();
  });
});
