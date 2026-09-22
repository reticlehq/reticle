import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { asProjectId, ReticleDir } from '@reticlehq/core';
import { emptyProjectRegistry, rememberProject } from '@reticlehq/core/artifacts';
import {
  ArtifactRootReason,
  UNMATCHED_SUBDIR,
  projectCandidatesFrom,
  resolveArtifactRoot,
  unmatchedRoot,
} from './artifact-root.js';
import type { ConfigDiscovery } from '@/command/cli/config/config-discovery.js';

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
      projectId: asProjectId('acme-web-9f3c1d'),
      candidates: candidatesOf([
        {
          path: '/repo/apps/web/.reticle.json',
          directory: '/repo/apps/web',
          projectId: asProjectId('acme-web-9f3c1d'),
        },
      ]),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.root).toBe(join('/repo/apps/web', ReticleDir.ROOT));
    expect(r.reason).toBe(ArtifactRootReason.MATCHED_PROJECT);
  });

  it('picks the match, ignoring other projects the search also found', () => {
    const r = resolveArtifactRoot({
      projectId: asProjectId('b-222'),
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
          projectId: asProjectId('acme-web-9f3c1d'),
        },
      ]),
      daemonRoot: DAEMON_ROOT,
    });

    expect(r.root).toBe(DAEMON_ROOT);
    expect(r.reason).toBe(ArtifactRootReason.NO_PROJECT_ID);
  });

  it('falls back to the daemon root when nothing discovered declares that project', () => {
    const r = resolveArtifactRoot({
      projectId: asProjectId('not-here-000'),
      candidates: candidatesOf([
        {
          path: '/repo/apps/web/.reticle.json',
          directory: '/repo/apps/web',
          projectId: asProjectId('acme-web-9f3c1d'),
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
      projectId: asProjectId('acme-web-9f3c1d'),
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
      projectId: asProjectId('acme-web-9f3c1d'),
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
      projectId: asProjectId('other-repo-77aa'),
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
      projectId: asProjectId('acme-9f3c'),
      candidates: projectCandidatesFrom(
        discovery([
          {
            path: '/repo/apps/web/.reticle.json',
            directory: '/repo/apps/web',
            projectId: asProjectId('acme-9f3c'),
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
      projectId: asProjectId('acme-9f3c'),
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

/**
 * Where a session's artifacts go when we CANNOT name the project.
 *
 * The fallback was the daemon's own root, unconditionally and silently, which is how Reticle came
 * to create `.reticle/` — journals included — in a user's backend directory. The daemon is started
 * by the user's editor, in whatever directory that editor was in, and a tree that was never
 * instrumented is a tree that never agreed to hold anybody's session data.
 *
 * Reported from the field as `.reticle/` reappearing in a backend after every delete.
 *
 * So: the daemon's root stays the fallback when the daemon really is sitting in a Reticle project
 * (the developer who ran `reticle serve` in their app — the case this behaviour was written for),
 * and otherwise the evidence goes to the user's own `~/.reticle/unmatched/<projectId>` rather than
 * into somebody's repository. It is never DROPPED: a verdict with nowhere to live is a worse
 * failure than one in an unexpected place, and the reason travels with the answer so the daemon can
 * say out loud which it did.
 */
describe('a root for a session whose project we cannot name', () => {
  it('uses the daemon root when the daemon is itself in a Reticle project', () => {
    expect(
      unmatchedRoot({ daemonRoot: '/repo/app/.reticle', daemonIsProject: true, home: '/home/u' }),
    ).toBe('/repo/app/.reticle');
  });

  it('keeps out of a directory that never asked for Reticle', () => {
    expect(
      unmatchedRoot({
        daemonRoot: '/repo/backend/.reticle',
        daemonIsProject: false,
        home: '/home/u',
        projectId: asProjectId('shop-web'),
      }),
    ).toBe(join('/home/u', ReticleDir.ROOT, UNMATCHED_SUBDIR, 'shop-web'));
  });

  it('still lands somewhere when the session named no project at all', () => {
    const root = unmatchedRoot({
      daemonRoot: '/repo/backend/.reticle',
      daemonIsProject: false,
      home: '/home/u',
    });
    expect(root.startsWith(join('/home/u', ReticleDir.ROOT, UNMATCHED_SUBDIR))).toBe(true);
  });

  it('never lets a projectId off the wire choose a directory', () => {
    // The id arrives in HELLO from the page, so it is untrusted input on a path join.
    const root = unmatchedRoot({
      daemonRoot: '/repo/backend/.reticle',
      daemonIsProject: false,
      home: '/home/u',
      projectId: asProjectId('../../../etc/passwd'),
    });
    expect(root.includes('..')).toBe(false);
  });
});

/**
 * `unnamed` was keyed on the ABSENCE of an identity, so it was not one project's directory — it was
 * the union of every project that ever failed to identify itself, sharing one set of durable files.
 *
 * Measured on a real machine: a single `~/.reticle/unmatched/unnamed/` holding `project.json`,
 * `envelopes.json`, `flake.json` and `assertion-tiers.json` merged across unrelated apps. Those are
 * the MEMORY tier — learned routes, per-route expectations, a quarantine ledger, an anti-downgrade
 * floor. One app's assertion tier becoming another app's floor is a wrong ANSWER, not untidy disk.
 *
 * A page that never stamped a project id is the ordinary case, not an edge: an app instrumented
 * without a build plugin, a page loaded before the plugin stamped one, any directory where the
 * daemon is a guest. So the bucket is reached constantly and by design.
 *
 * The origin the session is served from is the next-best identity available at that moment, and it
 * separates the apps that were colliding. It is not a project id and does not pretend to be: two
 * different apps served on one port at different times still share a bucket. That is a much smaller
 * wrong than every unidentified app in the world sharing one.
 */
describe('an unnameable project does not share a bucket with every other one', () => {
  const base = { daemonRoot: '/repo/app/.reticle', daemonIsProject: false, home: '/home/u' };

  it('separates two apps that never stamped a project id', () => {
    const a = unmatchedRoot({ ...base, origin: 'http://localhost:3000' });
    const b = unmatchedRoot({ ...base, origin: 'http://localhost:5173' });
    expect(a).not.toBe(b);
  });

  it('is stable for one origin, so a project keeps its own memory across sessions', () => {
    expect(unmatchedRoot({ ...base, origin: 'http://localhost:3000' })).toBe(
      unmatchedRoot({ ...base, origin: 'http://localhost:3000' }),
    );
  });

  it('still answers with a real path when even the origin is unknown', () => {
    const root = unmatchedRoot(base);
    expect(root.startsWith('/home/u')).toBe(true);
    expect(root.endsWith('/unnamed')).toBe(true);
  });

  it('prefers a real project id over the origin — the origin is only the fallback', () => {
    const root = unmatchedRoot({
      ...base,
      projectId: asProjectId('abc123'),
      origin: 'http://localhost:3000',
    });
    expect(root.endsWith('/abc123')).toBe(true);
  });
});
