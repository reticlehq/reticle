/**
 * A lease names the worktree it belongs to. Flow listing was still following the
 * page origin, so two worktrees of one project listed each other's flows.
 */

import { describe, expect, it } from 'vitest';
import { asProjectId } from '@reticlehq/core';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { FlowStore } from './flows.js';
import { flowsForSession } from './flow-store-for-session.js';

const DAEMON = '/daemon/.reticle';
const OTHER = '/worktrees/other/.reticle';
const CLAIMED = '/worktrees/this/.reticle';

describe('a lease root lists its own worktree', () => {
  it('reads the claimed root, not the worktree the origin maps to', async () => {
    const { fs } = createMemoryFs();
    const otherFlows = reticleDirPaths(OTHER).flows;
    const claimedFlows = reticleDirPaths(CLAIMED).flows;
    await fs.mkdir(otherFlows);
    await fs.mkdir(claimedFlows);
    await fs.writeFile(`${otherFlows}/tiers.json`, '{}');
    await fs.writeFile(`${claimedFlows}/signup.json`, '{}');

    const { flows, root } = flowsForSession(
      {
        fs,
        reticleRoot: DAEMON,
        flows: new FlowStore(fs, DAEMON, { now: () => 1 }),
        now: () => 1,
        artifactRootFor: () => ({ root: OTHER, reason: ArtifactRootReason.MATCHED_PROJECT }),
      } as unknown as ToolDeps,
      {
        projectId: asProjectId('acme-web-9f3c1d'),
        origin: 'http://localhost:5173',
        claimedRoot: CLAIMED,
      },
    );

    expect(root).toBe(CLAIMED);
    expect(await flows.list()).toEqual(['signup']);
  });
});
