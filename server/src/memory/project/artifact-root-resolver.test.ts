/**
 * The IO half, exercised at the level where its defect lives.
 *
 * `artifact-root.test.ts` next door tests `unmatchedRoot` as a pure function, handing it a
 * `daemonProjectId` directly. That is the right shape for the DECISION and it is blind to the other
 * half of #1244 — how the daemon's own id is READ. These go through `artifactRootResolver` instead,
 * with the two IO answers supplied, so a mistake in that reading has somewhere to show up.
 *
 * ## What the scenario actually is
 *
 * The worktree must NOT appear in `candidates`. That is the whole premise of #1244: the daemon runs
 * in the main checkout, discovery walks out from ITS working directory, and a sibling checkout is
 * never reached. A first version of this file listed the worktree among the candidates and its
 * headline test passed for the wrong reason — the root resolved to the worktree by ordinary matching
 * and the refusal being asserted never happened.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { asProjectId, ReticleDir } from '@reticlehq/core';
import type { ProjectCandidate } from '@reticlehq/core/artifacts';
import { ArtifactRootReason, UNMATCHED_SUBDIR } from './artifact-root.js';
import { artifactRootResolver } from './artifact-root-resolver.js';

const MAIN = '/repo/main';
const CLONE = '/repo/clone';
const MAIN_ID = 'main-repo-1a2b';
const WORKTREE_ID = 'worktree-b-3c4d';

/** What discovery finds from the main checkout's cwd: itself. Not its sibling worktree. */
const onlyMain = (): ProjectCandidate[] => [{ projectId: MAIN_ID, directory: MAIN }];

/** What the resolver does when the session names a project, and what it decided. */
const resolveInMain = (named: string) =>
  artifactRootResolver(join(MAIN, ReticleDir.ROOT), {
    candidates: onlyMain,
    daemonIsProject: () => true,
  })(asProjectId(named));

const inUnmatched = (root: string, projectId: string): boolean =>
  root.endsWith(join(UNMATCHED_SUBDIR, projectId));

describe('a daemon that cannot place the project it was asked about', () => {
  /**
   * #1244, through the resolver. The daemon sits in the main checkout; a worktree of the same repo
   * connects announcing ITS OWN id, which nothing on this machine knows. The old code returned the
   * daemon's root here — and the returned path named it, so the worktree's intents, flows and runs
   * landed in the main checkout with nothing looking wrong.
   */
  it('does not hand a worktree’s artifacts to the main checkout', () => {
    const resolved = resolveInMain(WORKTREE_ID);

    expect(resolved.root, 'the main checkout is not this session’s project').not.toBe(
      join(MAIN, ReticleDir.ROOT),
    );
    expect(inUnmatched(resolved.root, WORKTREE_ID)).toBe(true);
    expect(resolved.reason).toBe(ArtifactRootReason.NO_MATCH);
  });

  /** The daemon serving its own project resolves through ordinary matching, not the fallback. */
  it('resolves the daemon’s own project to itself', () => {
    const resolved = resolveInMain(MAIN_ID);

    expect(resolved.root).toBe(join(MAIN, ReticleDir.ROOT));
    expect(resolved.reason).toBe(ArtifactRootReason.MATCHED_PROJECT);
  });

  /**
   * Nothing named: a pre-2.0 SDK sends no projectId. There is no identity to disagree with, and the
   * daemon's own root is the case this fallback was written for.
   */
  it('keeps the daemon root when the session named no project at all', () => {
    const resolved = artifactRootResolver(join(MAIN, ReticleDir.ROOT), {
      candidates: onlyMain,
      daemonIsProject: () => true,
    })(undefined);

    expect(resolved.root).toBe(join(MAIN, ReticleDir.ROOT));
  });

  /** A daemon that is only a guest never writes into the tree it happens to be started in. */
  it('keeps out of a directory that never asked for Reticle', () => {
    const resolved = artifactRootResolver(join('/repo/backend', ReticleDir.ROOT), {
      candidates: onlyMain,
      daemonIsProject: () => false,
    })(asProjectId(WORKTREE_ID));

    expect(resolved.root).not.toBe(join('/repo/backend', ReticleDir.ROOT));
    expect(inUnmatched(resolved.root, WORKTREE_ID)).toBe(true);
  });
});

/**
 * The daemon-id lookup has exactly ONE reachable effect, and it is not the case above.
 *
 * `resolveArtifactRoot` and `daemonOwnProjectId` read the SAME candidate list, so a named project
 * that cannot be matched is by definition a project no candidate declares — and the daemon's own id,
 * read off that list, cannot equal it. The refusal above therefore holds however the id is read.
 *
 * The one place the id changes the answer is AMBIGUOUS: two checkouts declare the session's project,
 * so the root cannot be picked, and whether the daemon's OWN directory is one of them decides between
 * the daemon root and the unmatched bucket. A lookup that read the wrong directory, or none, would
 * send the daemon's own artifacts to the unmatched bucket — this is the test that says so.
 */
describe('a project two checkouts both declare', () => {
  it('uses the daemon root when the daemon’s own checkout is one of them', () => {
    const resolved = artifactRootResolver(join(MAIN, ReticleDir.ROOT), {
      candidates: () => [
        { projectId: MAIN_ID, directory: MAIN },
        { projectId: MAIN_ID, directory: CLONE },
      ],
      daemonIsProject: () => true,
    })(asProjectId(MAIN_ID));

    expect(resolved.reason).toBe(ArtifactRootReason.AMBIGUOUS);
    expect(resolved.root, 'the daemon’s own checkout is one of the two').toBe(
      join(MAIN, ReticleDir.ROOT),
    );
  });

  /**
   * And when the daemon is in NEITHER of them it has proved nothing about the project it was asked
   * about, so the artifacts go to the unmatched bucket rather than into whatever tree it sits in.
   */
  it('declines when the daemon’s checkout is not among them', () => {
    const resolved = artifactRootResolver(join('/repo/backend', ReticleDir.ROOT), {
      candidates: () => [
        { projectId: MAIN_ID, directory: MAIN },
        { projectId: MAIN_ID, directory: CLONE },
      ],
      daemonIsProject: () => true,
    })(asProjectId(MAIN_ID));

    expect(resolved.root).not.toBe(join('/repo/backend', ReticleDir.ROOT));
    expect(inUnmatched(resolved.root, MAIN_ID)).toBe(true);
  });
});
