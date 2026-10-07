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
import { join, sep } from 'node:path';
import { asProjectId, ReticleDir } from '@reticlehq/core';
import type { ProjectCandidate } from '@reticlehq/core/artifacts';
import { ArtifactRootReason, UNMATCHED_SUBDIR } from './artifact-root.js';
import { artifactRootResolver } from './artifact-root-resolver.js';

/**
 * Built by the platform's own path module, not spelled as POSIX literals.
 *
 * The daemon-id lookup is one exact string comparison — `dirname(daemonRoot) === candidate.directory`
 * — and `dirname(join(x, ReticleDir.ROOT))` returns `x` only when both sides went through the same
 * path implementation. A literal `'/repo/main'` against a `join`-ed daemon root is equal on POSIX
 * and never on Windows (`'\repo\main'` vs `'/repo/main'`), so the AMBIGUOUS spec below — the one
 * place that lookup's answer is observable — found no candidate and resolved to the unmatched
 * bucket for the FIXTURE's reason, failing the Windows merge-queue job. The resolver was right.
 *
 * Production is safe from this by construction: the daemon root, `process.cwd()`, what `init` wrote
 * into the registry and what discovery walks all come from one platform's `path`.
 */
const MAIN = join(sep, 'repo', 'main');
const CLONE = join(sep, 'repo', 'clone');
const BACKEND = join(sep, 'repo', 'backend');
const MAIN_ID = 'main-repo-1a2b';
const WORKTREE_ID = 'worktree-b-3c4d';

/** What discovery finds from the main checkout's cwd: itself. Not its sibling worktree. */
const onlyMain = (): ProjectCandidate[] => [{ projectId: MAIN_ID, directory: MAIN }];

/** What the resolver does when the session names a project, and what it decided. */
const resolveInMain = (named: string) =>
  artifactRootResolver(join(MAIN, ReticleDir.ROOT), {
    candidates: onlyMain,
    daemonIsProject: () => true,
    servingDirectory: noServingDirectory,
  })(asProjectId(named));

/** Most specs are not about the serving process: nothing observable, as on a remote page. */
const noServingDirectory = (): undefined => undefined;

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
      servingDirectory: noServingDirectory,
    })(undefined);

    expect(resolved.root).toBe(join(MAIN, ReticleDir.ROOT));
  });

  /** A daemon that is only a guest never writes into the tree it happens to be started in. */
  it('keeps out of a directory that never asked for Reticle', () => {
    const resolved = artifactRootResolver(join(BACKEND, ReticleDir.ROOT), {
      candidates: onlyMain,
      daemonIsProject: () => false,
      servingDirectory: noServingDirectory,
    })(asProjectId(WORKTREE_ID));

    expect(resolved.root).not.toBe(join(BACKEND, ReticleDir.ROOT));
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
      servingDirectory: noServingDirectory,
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
    const resolved = artifactRootResolver(join(BACKEND, ReticleDir.ROOT), {
      candidates: () => [
        { projectId: MAIN_ID, directory: MAIN },
        { projectId: MAIN_ID, directory: CLONE },
      ],
      daemonIsProject: () => true,
      servingDirectory: noServingDirectory,
    })(asProjectId(MAIN_ID));

    expect(resolved.root).not.toBe(join(BACKEND, ReticleDir.ROOT));
    expect(inUnmatched(resolved.root, MAIN_ID)).toBe(true);
  });
});

/**
 * Worktree-per-PR, through the resolver: both checkouts declare the project (one committed
 * `.reticle.json`), the daemon was started in the primary, and the page was served by the worktree's
 * dev server. The old answer was the daemon's own root — the primary — so the worktree's flows never
 * reached its branch and `reticle gate` run there reported nothing covered.
 */
describe('a project two checkouts declare, served from one of them', () => {
  const ORIGIN = 'http://localhost:5174';
  const both = (): ProjectCandidate[] => [
    { projectId: MAIN_ID, directory: MAIN },
    { projectId: MAIN_ID, directory: CLONE },
  ];

  it('writes into the checkout whose dev server served the page', () => {
    const asked: string[] = [];
    const resolved = artifactRootResolver(join(MAIN, ReticleDir.ROOT), {
      candidates: both,
      daemonIsProject: () => true,
      servingDirectory: (origin) => {
        asked.push(origin);
        return CLONE;
      },
    })(asProjectId(MAIN_ID), ORIGIN);

    expect(asked).toEqual([ORIGIN]);
    expect(resolved.reason).toBe(ArtifactRootReason.MATCHED_PROJECT);
    expect(resolved.root).toBe(join(CLONE, ReticleDir.ROOT));
  });

  it('keeps today’s answer when the serving directory cannot be found', () => {
    const resolved = artifactRootResolver(join(MAIN, ReticleDir.ROOT), {
      candidates: both,
      daemonIsProject: () => true,
      servingDirectory: () => undefined,
    })(asProjectId(MAIN_ID), ORIGIN);

    expect(resolved.reason).toBe(ArtifactRootReason.AMBIGUOUS);
    expect(resolved.root).toBe(join(MAIN, ReticleDir.ROOT));
  });

  /** The lookup shells out; a project that already resolved must never pay for it. */
  it('does not look for the serving directory when one checkout already matches', () => {
    let looked = false;
    artifactRootResolver(join(MAIN, ReticleDir.ROOT), {
      candidates: onlyMain,
      daemonIsProject: () => true,
      servingDirectory: () => {
        looked = true;
        return CLONE;
      },
    })(asProjectId(MAIN_ID), ORIGIN);

    expect(looked).toBe(false);
  });
});

/**
 * Sync reads this list. It used to keep its own without the announced dev servers, so the merchant
 * dashboard's runs were written to its `.reticle/runs/` and never sent: 52 sync cycles in one drive
 * pushed other directories' impact and not one of that app's runs.
 */
describe('the projects this machine knows', () => {
  it('include a project known only through the dev server it is running', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const { devServerRegistryFileName, ReticleEnv } = await import('@reticlehq/core');
    const { knownProjectCandidates } = await import('./artifact-root-resolver.js');
    const state = mkdtempSync(joinPath(tmpdir(), 'reticle-state-'));
    const app = mkdtempSync(joinPath(tmpdir(), 'merchant-'));
    writeFileSync(
      joinPath(state, devServerRegistryFileName(5273)),
      JSON.stringify({
        port: 5273,
        pid: 1,
        root: app,
        url: 'http://localhost:5273',
        startedAt: 1,
        projectId: 'merchant-1',
      }),
    );
    const previous = process.env[ReticleEnv.STATE_DIR];
    process.env[ReticleEnv.STATE_DIR] = state;
    try {
      expect(knownProjectCandidates().map((c) => c.directory)).toContain(app);
    } finally {
      if (previous === undefined) delete process.env[ReticleEnv.STATE_DIR];
      else process.env[ReticleEnv.STATE_DIR] = previous;
    }
  });
});
