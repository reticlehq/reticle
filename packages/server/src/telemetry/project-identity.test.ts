/**
 * One project must produce one projectId, whichever directory inside it a process happens to start in.
 *
 * In the field a single project minted many distinct projectIds, with `projectIdSource` =
 * `cwd` on the large majority of events. `reticle init` runs in the app directory; the daemon is spawned by
 * the agent from wherever its client's cwd happens to be. Two ids, one app — so the install half and
 * the session half of the funnel could not be joined, and the single rate this product is measured
 * by ("how many installs reach a verification report") was not computable at all.
 *
 * The origin path was already stable. The FALLBACK was not: it hashed the raw cwd, so every
 * subdirectory of one app was a different project.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectIdSource } from '@reticlehq/core/telemetry';
import { projectFingerprint } from './telemetry.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reticle-identity-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A directory `a/b/c` under the fixture root, created. */
const dir = (...parts: readonly string[]): string => {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

const gitRepo = (at: string, origin?: string): void => {
  mkdirSync(join(at, '.git'), { recursive: true });
  writeFileSync(
    join(at, '.git', 'config'),
    origin === undefined ? '[core]\n' : `[remote "origin"]\n\turl = ${origin}\n`,
    'utf8',
  );
};

const pkg = (at: string, name: string): void => {
  writeFileSync(join(at, 'package.json'), JSON.stringify({ name }), 'utf8');
};

describe('projectFingerprint', () => {
  it('gives a pushed repo the same id from any directory inside it', () => {
    const app = dir('app');
    gitRepo(app, 'git@github.com:acme/web.git');
    const deep = dir('app', 'src', 'components');

    const a = projectFingerprint(app);
    const b = projectFingerprint(deep);

    expect(a.projectId).toBe(b.projectId);
    expect(a.source).toBe(ProjectIdSource.GIT_ORIGIN);
  });

  it('gives an UNPUSHED repo one id from any directory inside it', () => {
    // 45% of profiled projects report git `none` or `local_only`. Before this, each subdirectory of
    // such a project minted its own id — which is where the id explosion came from.
    const app = dir('app');
    gitRepo(app);
    const deep = dir('app', 'packages', 'ui', 'src');

    const a = projectFingerprint(app);
    const b = projectFingerprint(deep);

    expect(a.projectId).toBe(b.projectId);
    expect(a.source).toBe(ProjectIdSource.GIT_ROOT);
    expect(b.source).toBe(ProjectIdSource.GIT_ROOT);
  });

  it('falls back to the nearest package.json root when there is no git at all', () => {
    const app = dir('app');
    pkg(app, 'my-app');
    const deep = dir('app', 'src', 'features', 'billing');

    const a = projectFingerprint(app);
    const b = projectFingerprint(deep);

    expect(a.projectId).toBe(b.projectId);
    expect(a.source).toBe(ProjectIdSource.PACKAGE_ROOT);
  });

  it('prefers the git root over a nested package.json, so a monorepo is ONE project', () => {
    // The daemon starting in `frontend/` and init running at the repo root must agree. Keying on the
    // nearest package.json alone would split them — `frontend/package.json` is a root too.
    const repo = dir('repo');
    gitRepo(repo);
    const frontend = dir('repo', 'frontend');
    pkg(frontend, 'frontend');
    pkg(repo, 'monorepo');

    expect(projectFingerprint(frontend).projectId).toBe(projectFingerprint(repo).projectId);
  });

  it('still separates two genuinely different projects', () => {
    const a = dir('one');
    const b = dir('two');
    pkg(a, 'one');
    pkg(b, 'two');

    expect(projectFingerprint(a).projectId).not.toBe(projectFingerprint(b).projectId);
  });

  it('reports `cwd` only when there is nothing else to key on', () => {
    const bare = dir('bare');
    expect(projectFingerprint(bare).source).toBe(ProjectIdSource.CWD);
  });

  it('never emits the path or the origin itself — only a 32-char hash', () => {
    const app = dir('app');
    gitRepo(app, 'git@github.com:acme/secret-internal-thing.git');
    const { projectId } = projectFingerprint(app);

    expect(projectId).toMatch(/^[0-9a-f]{32}$/);
    expect(projectId).not.toContain('acme');
    expect(projectId).not.toContain(root);
  });
});
