/**
 * `affected`, `flows` and `change` must read the flows from ONE folder (#1996).
 *
 * The app sat in `frontend/clinical-ai-ui` with its own `.reticle`, and the repo root had another.
 * `reticle_verify { action: "affected" }` named `drive-ask-cited-answer`, and then
 * `{ action: "flows", names: ["drive-ask-cited-answer"] }` said that no flow had that name. The
 * agent could not replay a flow that `affected` had just named.
 *
 * `flows` reads the store through `flowsForSession`, which takes the root a lease claimed.
 * `affected` and `change` built their own store from `sessionRoot`, which skips the session, and so
 * the claim, when no resolver is wired and no session is named. `reticle verify` builds its deps
 * like that, so `affected` read the daemon root while `flows` read the folder the lease claimed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProjectId, ReticleTool } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { claimArtifactRoot, dropArtifactRootClaim } from '@/memory/project/root-claims.js';
import { sessionTarget } from '@/memory/project/session-root.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { AFFECTED_TOOLS } from './affected-tools.js';
import { FlowStore } from './flows.js';
import type { CompiledProgram } from './recording/tape/recordings.js';
import { resolveSuiteSelection } from './suite-selection.js';

const LEASE = 'lease-1996';
const FLOW = 'drive-ask-cited-answer';
const PROJECT = asProjectId('clinical-ai-ui-9dd6e61c');

const program = (name: string): CompiledProgram =>
  ({ name, steps: [] }) as unknown as CompiledProgram;

describe('affected and flows read one flow folder', () => {
  let dir = '';
  let repoRoot = '';
  let appRoot = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-1996-'));
    repoRoot = join(dir, '.reticle');
    appRoot = join(dir, 'frontend', 'clinical-ai-ui', '.reticle');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(appRoot, { recursive: true });
  });

  afterEach(async () => {
    dropArtifactRootClaim(LEASE);
    await rm(dir, { recursive: true, force: true });
  });

  function deps(): ToolDeps {
    const fs = createNodeFileSystem();
    const sessions: Partial<SessionManager> = {
      resolve: () =>
        ({ id: LEASE, url: 'http://localhost:5173/', projectId: PROJECT }) as ReturnType<
          SessionManager['resolve']
        >,
    };
    // No `artifactRootFor`, as `reticle verify` builds its deps. The daemon root is the app's.
    return {
      fs,
      reticleRoot: appRoot,
      flows: new FlowStore(fs, appRoot, { now: () => 0 }),
      sessions: sessions as SessionManager,
      now: () => 0,
    } as unknown as ToolDeps;
  }

  it('finds the flow by the name that affected gave', async () => {
    const d = deps();
    // The lease claimed the repo root, and the flow is saved there.
    claimArtifactRoot(LEASE, repoRoot);
    await new FlowStore(d.fs, repoRoot, { now: () => 0 }).save(program(FLOW), undefined, PROJECT);

    const affectedTool = AFFECTED_TOOLS.find((t) => ReticleTool.AFFECTED === t.name);
    if (affectedTool === undefined) {
      throw new Error('reticle_affected is not defined');
    }
    const out = (await affectedTool.handler(d, { files: ['src/App.tsx'] })) as {
      affected: string[];
    };
    expect(out.affected).toContain(FLOW);

    const selected = await resolveSuiteSelection(d, sessionTarget(d, undefined), {
      names: out.affected,
    });
    expect(selected.run).toEqual(out.affected);
  });
});
