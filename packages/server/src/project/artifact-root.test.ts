import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { emptyProjectRegistry, rememberProject } from '@reticlehq/core';
import { ArtifactRootReason, projectCandidatesFrom, resolveArtifactRoot } from './artifact-root.js';
import type { ConfigDiscovery } from '../cli/config-discovery.js';

/**
 * Every artifact Reticle writes resolved against the DAEMON's `process.cwd()`, never against the
 * project the connected session belongs to. A user-scoped MCP registration is the common case and
 * an editor spawns that daemon from wherever it likes — the user's home directory, another repo's
 * root, or `/`. Three shapes were reported from the field, all of them this one defect:
 *
 *   - `cwd=/` resolved to `/.reticle` and every save died on `ENOENT: mkdir '/.reticle'`;
 *   - a daemon started in project A, driving project B, wrote B's flow into A's tree and reported
 *     success without saying where, so it was found by hand with `find`;
 *   - everything downstream inherited it, so `verify_change` could only ever answer "unknown".
 *
 * The session already carries the answer. HELLO stamps a `projectId`, `.reticle.json` declares the
 * same id next to the code it configures, and config discovery already finds those files. Matching
 * one to the other needs no wire change and works with every SDK already in the field.
 */

const DAEMON_ROOT = join('/daemon-cwd', ReticleDir.ROOT);

function discovery(found: ConfigDiscovery['found']): ConfigDiscovery {
  return { found, searched: ['/anywhere'] };
}

/** The resolver takes candidates; these specs describe them as configs, which is how they arrive. */
function candidatesOf(found: ConfigDiscovery['found']) {
  return projectCandidatesFrom(discovery(found), emptyProjectRegistry());
}

describe('resolveArtifactRoot', () => {
  it('resolves to the matching project, not the daemon cwd', () => {
    const r = resolveArtifactRoot({
      projectId: 'acme-web-9f3c1d',
      candidates: candidatesOf([
        {
          path: '/repo/apps/web/.reticle.json',
          directory: '/repo/apps/web',
          projectId: 'acme-web-9f3c1d',
        },
      ]),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.root).toBe(join('/repo/apps/web', ReticleDir.ROOT));
    expect(r.reason).toBe(ArtifactRootReason.MATCHED_PROJECT);
  });

  it('picks the match, ignoring other projects the search also found', () => {
    const r = resolveArtifactRoot({
      projectId: 'b-222',
      candidates: candidatesOf([
        { path: '/repo/apps/a/.reticle.json', directory: '/repo/apps/a', projectId: 'a-111' },
        { path: '/repo/apps/b/.reticle.json', directory: '/repo/apps/b', projectId: 'b-222' },
        { path: '/repo/apps/c/.reticle.json', directory: '/repo/apps/c', projectId: 'c-333' },
      ]),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.root).toBe(join('/repo/apps/b', ReticleDir.ROOT));
  });

  /**
   * A 1.x SDK sends no projectId. There is nothing to match on, so the daemon root is the only
   * honest answer — and the reason has to say which of the fallbacks this was, because "we could not
   * tell which project" and "we looked and found nothing" are different facts to a caller.
   */
  it('falls back to the daemon root when the session declares no projectId', () => {
    const r = resolveArtifactRoot({
      projectId: undefined,
      candidates: candidatesOf([
        {
          path: '/repo/apps/web/.reticle.json',
          directory: '/repo/apps/web',
          projectId: 'acme-web-9f3c1d',
        },
      ]),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.root).toBe(DAEMON_ROOT);
    expect(r.reason).toBe(ArtifactRootReason.NO_PROJECT_ID);
  });

  it('falls back to the daemon root when nothing discovered declares that project', () => {
    const r = resolveArtifactRoot({
      projectId: 'not-here-000',
      candidates: candidatesOf([
        {
          path: '/repo/apps/web/.reticle.json',
          directory: '/repo/apps/web',
          projectId: 'acme-web-9f3c1d',
        },
      ]),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.root).toBe(DAEMON_ROOT);
    expect(r.reason).toBe(ArtifactRootReason.NO_MATCH);
  });

  /**
   * Two checkouts of the same repo — a git worktree, a copy on another disk — declare the same
   * projectId. Choosing one silently is how an agent's flow lands in a tree it never drove, which is
   * the exact failure this function exists to end. Config discovery is deliberately not a pick-one
   * function for the same reason; neither is this.
   */
  it('refuses to guess when two checkouts declare the same project', () => {
    const r = resolveArtifactRoot({
      projectId: 'acme-web-9f3c1d',
      candidates: candidatesOf([
        { path: '/repo/.reticle.json', directory: '/repo', projectId: 'acme-web-9f3c1d' },
        { path: '/worktree/.reticle.json', directory: '/worktree', projectId: 'acme-web-9f3c1d' },
      ]),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.root).toBe(DAEMON_ROOT);
    expect(r.reason).toBe(ArtifactRootReason.AMBIGUOUS);
    expect(r.candidates).toEqual(['/repo', '/worktree']);
  });

  it('ignores a discovered config that declares no projectId at all', () => {
    const r = resolveArtifactRoot({
      projectId: 'acme-web-9f3c1d',
      candidates: candidatesOf([{ path: '/repo/.reticle.json', directory: '/repo' }]),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.root).toBe(DAEMON_ROOT);
    expect(r.reason).toBe(ArtifactRootReason.NO_MATCH);
  });

  /**
   * The save that reported success without saying where cost a reporter a `find`. Every result
   * carries the resolved root so a caller can print it, whichever branch it came from.
   */
  it('always carries a root, on every branch', () => {
    for (const reason of Object.values(ArtifactRootReason)) {
      expect(typeof reason).toBe('string');
    }
    const fallback = resolveArtifactRoot({
      projectId: undefined,
      candidates: candidatesOf([]),
      daemonRoot: DAEMON_ROOT,
    });
    expect(fallback.root).toBe(DAEMON_ROOT);
  });
});

/**
 * The registry is the half config discovery structurally cannot do. Discovery walks out from the
 * daemon's own directory, so a daemon in repo A never sees repo B however far it walks — and that is
 * the default arrangement when an editor starts a user-scoped MCP server.
 */
describe('candidates from both sources', () => {
  it('resolves a project discovery cannot reach, because init remembered it', () => {
    const registry = rememberProject(
      emptyProjectRegistry(),
      'other-repo-77aa',
      '/elsewhere/other-repo',
      1000,
    );
    const r = resolveArtifactRoot({
      projectId: 'other-repo-77aa',
      candidates: projectCandidatesFrom(discovery([]), registry),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.root).toBe(join('/elsewhere/other-repo', ReticleDir.ROOT));
    expect(r.reason).toBe(ArtifactRootReason.MATCHED_PROJECT);
  });

  /**
   * The common case once both sources exist: the daemon IS in the tree, so discovery finds the same
   * `.reticle.json` the registry remembers. Two sources naming one directory is agreement, and must
   * never read as two competing checkouts.
   */
  it('does not call one directory named twice an ambiguity', () => {
    const registry = rememberProject(emptyProjectRegistry(), 'acme-9f3c', '/repo/apps/web', 1000);
    const r = resolveArtifactRoot({
      projectId: 'acme-9f3c',
      candidates: projectCandidatesFrom(
        discovery([
          {
            path: '/repo/apps/web/.reticle.json',
            directory: '/repo/apps/web',
            projectId: 'acme-9f3c',
          },
        ]),
        registry,
      ),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.reason).toBe(ArtifactRootReason.MATCHED_PROJECT);
    expect(r.root).toBe(join('/repo/apps/web', ReticleDir.ROOT));
  });

  /**
   * A registry entry that has gone stale — the project was re-cloned elsewhere and `init` re-run in
   * the new place — genuinely IS two checkouts as far as this machine knows, and the honest answer
   * is to refuse and name both rather than pick the one that happens to sort first.
   */
  it('still refuses when the two sources name genuinely different checkouts', () => {
    const registry = rememberProject(emptyProjectRegistry(), 'acme-9f3c', '/old/clone', 1000);
    const r = resolveArtifactRoot({
      projectId: 'acme-9f3c',
      candidates: projectCandidatesFrom(
        discovery([
          { path: '/new/clone/.reticle.json', directory: '/new/clone', projectId: 'acme-9f3c' },
        ]),
        registry,
      ),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.reason).toBe(ArtifactRootReason.AMBIGUOUS);
    expect(r.candidates).toEqual(['/new/clone', '/old/clone']);
  });

  it('drops a discovered config with no projectId rather than inventing a candidate', () => {
    const candidates = projectCandidatesFrom(
      discovery([{ path: '/repo/.reticle.json', directory: '/repo' }]),
      emptyProjectRegistry(),
    );
    expect(candidates).toEqual([]);
  });
});
