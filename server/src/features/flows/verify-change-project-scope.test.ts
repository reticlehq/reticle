/**
 * `verify_change` and `affected` must ask about the SESSION's project, not the daemon's directory.
 *
 * `session-root.ts` already names this exact failure in its own comment, as the thing it exists to
 * prevent: "a `flow_save` that resolves to the project while `verify_change` still reads the
 * daemon's own directory would be a worse defect than the one being fixed — the flow would save
 * successfully and then be invisible to the tool that exists to replay it, which reads as 'no flows
 * covered this change' rather than as an error."
 *
 * That is what shipped. `verify-change-tools.ts` resolves the ROOT correctly through
 * `sessionRoot(deps, sessionId)`, and then `loadNamedFlows` reads the PROJECT ID from
 * `readProjectId(process.cwd())` internally — so half the address comes from the session and half
 * from wherever the daemon happens to be. A globally-registered MCP server runs with `cwd` at `/`
 * or `$HOME` (#685), which has no `.reticle.json`, so the id is `undefined` and the flow list comes
 * back EMPTY.
 *
 * Empty is the dangerous answer rather than an error: `affected` reports "no saved flows exist yet"
 * and `verify_change` reports nothing covering the change. Both are a confident negative computed
 * from the wrong project — the false-green shape this repo exists to remove.
 *
 * `resolveChangedFiles` has the same shape one layer down: it runs git in `process.cwd()`, so a
 * daemon outside the repo diffs the wrong tree, or no tree.
 */

import { describe, expect, it } from 'vitest';
import { loadNamedFlows, resolveChangedFiles } from '../../command/cli/cli-flow-commands.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '../../memory/project/fs/fs-port.js';
import { FlowStore } from './flows.js';
import type { CompiledProgram } from './recording/tape/recordings.js';

const SESSION_PROJECT = 'app-under-test';
const DAEMON_PROJECT = 'somewhere-else';

const program = (name: string): CompiledProgram =>
  ({ name, steps: [] }) as unknown as CompiledProgram;

describe('flow lookup is addressed by argument, not by the daemon’s cwd', () => {
  it('takes the projectId from its caller', () => {
    // The signature IS the assertion. A helper that reaches for a global cannot be pointed at the
    // session's project by any caller, however correctly that caller resolved it.
    expect(
      loadNamedFlows.length,
      'loadNamedFlows(fs, reticleRoot, projectId) — three arguments, none of them ambient',
    ).toBe(3);
  });

  it('finds the flows of the project it was HANDED, not of some other one', async () => {
    // The behaviour behind the signature. A flow saved under the session's project must be
    // reachable by naming that project — which is impossible while the id is read from a global.
    const dir = await mkdtemp(join(tmpdir(), 'reticle-scope-'));
    try {
      const root = join(dir, '.reticle');
      const fs = createNodeFileSystem();
      await new FlowStore(fs, root, { now: () => 0 }).save(
        program('checkout'),
        undefined,
        SESSION_PROJECT,
      );

      const mine = await loadNamedFlows(fs, root, SESSION_PROJECT);
      expect(mine.map((f) => f.name)).toContain('checkout');

      // And the negative, which is the shape the defect produced: asking as the wrong project
      // returns EMPTY rather than erroring, and `affected` renders that as "no saved flows exist
      // yet" — a confident negative computed from someone else's project.
      const theirs = await loadNamedFlows(fs, root, DAEMON_PROJECT);
      expect(theirs.map((f) => f.name)).not.toContain('checkout');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('takes the repo to diff from its caller', () => {
    expect(
      resolveChangedFiles.length,
      'resolveChangedFiles(files, since, cwd) — the tree to diff is the caller’s to name',
    ).toBe(3);
  });
});
