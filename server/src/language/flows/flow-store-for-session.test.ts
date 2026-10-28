import { describe, expect, it } from 'vitest';
import { flowsForSession } from './flow-store-for-session.js';
import { FlowStore } from './flows.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

const DAEMON_ROOT = '/daemon-cwd/.reticle';
const CALLER_ROOT = '/caller/.reticle';

function deps(): ToolDeps {
  return {
    reticleRoot: DAEMON_ROOT,
    flows: new FlowStore({} as never, DAEMON_ROOT, { now: () => 0 }),
    now: () => 0,
    artifactRootFor: () => ({ root: DAEMON_ROOT, reason: ArtifactRootReason.NO_MATCH }),
  } as unknown as ToolDeps;
}

/*
 * `reticle verify <url>` from one app's folder, against a daemon started in another, replayed the
 * DAEMON folder's flows on the leased tab, and wrote the runs to the caller's folder. The lease
 * claimed the caller's root, and runs read that claim, but flows did not.
 */
describe('the flow store of a leased session', () => {
  it('is the root the lease claimed, not the daemon root', () => {
    expect(flowsForSession(deps(), { projectId: undefined, claimedRoot: CALLER_ROOT }).root).toBe(
      CALLER_ROOT,
    );
  });

  it('is the resolved root when no lease claimed one', () => {
    expect(flowsForSession(deps(), { projectId: undefined }).root).toBe(DAEMON_ROOT);
  });
});
