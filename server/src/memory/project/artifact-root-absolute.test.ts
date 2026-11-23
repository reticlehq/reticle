/**
 * Every artifact root the resolver hands out is absolute (#2429).
 *
 * An agent got `screenshot.path = apps/clinic/.reticle/visual/runs/…/0141-assert.jpg` from
 * `reticle_assert`. The step-shot path is `join(stepShotDir(root, runId), file)`, so a relative path
 * comes from a relative root: a discovered or registered project folder written as a relative path,
 * or a daemon started with a relative root. Such a path resolves against the daemon's working
 * folder, and the agent's image viewer, which runs elsewhere, cannot find the file.
 */
import { describe, expect, it } from 'vitest';
import { isAbsolute, join, resolve } from 'node:path';
import { asProjectId, ReticleDir } from '@reticlehq/core';
import { artifactRootResolver } from './artifact-root-resolver.js';

const ID = 'clinic-1a2b';
const RELATIVE_PROJECT = join('apps', 'clinic');
const noServingDirectory = (): undefined => undefined;

describe('an artifact root', () => {
  it('is absolute when discovery names the project folder as a relative path', () => {
    const resolveRoot = artifactRootResolver(resolve(ReticleDir.ROOT), {
      candidates: () => [{ projectId: ID, directory: RELATIVE_PROJECT }],
      daemonIsProject: () => false,
      servingDirectory: noServingDirectory,
    });

    const { root } = resolveRoot(asProjectId(ID));

    expect(isAbsolute(root)).toBe(true);
    expect(root).toBe(resolve(RELATIVE_PROJECT, ReticleDir.ROOT));
  });

  it('is absolute when the daemon itself was started with a relative root', () => {
    const resolveRoot = artifactRootResolver(ReticleDir.ROOT, {
      candidates: () => [],
      daemonIsProject: () => true,
      servingDirectory: noServingDirectory,
    });

    const { root } = resolveRoot(undefined);

    expect(isAbsolute(root)).toBe(true);
  });

  it('keeps a root that was already absolute unchanged', () => {
    const project = resolve('srv', 'clinic');
    const resolveRoot = artifactRootResolver(resolve(ReticleDir.ROOT), {
      candidates: () => [{ projectId: ID, directory: project }],
      daemonIsProject: () => false,
      servingDirectory: noServingDirectory,
    });

    expect(resolveRoot(asProjectId(ID)).root).toBe(join(project, ReticleDir.ROOT));
  });
});
