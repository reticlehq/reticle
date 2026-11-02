/**
 * `affected` answers about the project of the tab being driven (#1550).
 *
 * The tool took no session, so a daemon started in project A answered for a tab leased in project B:
 * it listed A's flows as `unknownProvenance`, or ran `git` in `~/.reticle/unmatched/<id>`, and in a
 * worktree it read the primary checkout. Nothing said the answer was about another project.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProjectId, ReticleTool } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { AFFECTED_TOOLS } from './affected-tools.js';
import { FlowStore } from './flows.js';
import type { CompiledProgram } from './recording/tape/recordings.js';

const A = asProjectId('project-a');
const B = asProjectId('project-b');
const GONE = asProjectId('project-with-no-folder');
const WORKTREE_ORIGIN = 'http://localhost:5174';

const program = (name: string): CompiledProgram =>
  ({ name, steps: [] }) as unknown as CompiledProgram;

interface FakeSession {
  id: string;
  url: string;
  projectId: ReturnType<typeof asProjectId>;
}

describe('affected and the project being driven', () => {
  let dir = '';
  let rootA = '';
  let rootB = '';
  let rootWorktree = '';
  let rootUnmatched = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-1550-'));
    rootA = join(dir, 'a', '.reticle');
    rootB = join(dir, 'b', '.reticle');
    rootWorktree = join(dir, 'a-worktree', '.reticle');
    rootUnmatched = join(dir, 'home', '.reticle', 'unmatched', GONE);
    for (const root of [rootA, rootB, rootWorktree, rootUnmatched]) {
      await mkdir(root, { recursive: true });
    }
    const fs = createNodeFileSystem();
    await new FlowStore(fs, rootA, { now: () => 0 }).save(program('flow-of-a'), undefined, A);
    await new FlowStore(fs, rootB, { now: () => 0 }).save(program('flow-of-b'), undefined, B);
    await new FlowStore(fs, rootWorktree, { now: () => 0 }).save(
      program('flow-of-worktree'),
      undefined,
      A,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deps(connected: readonly FakeSession[]): ToolDeps {
    const fs = createNodeFileSystem();
    const sessions: Partial<SessionManager> = {
      count: () => connected.length,
      resolve: (id?: string) => {
        const [only] = connected;
        const found = id === undefined ? only : connected.find((s) => s.id === id);
        if (found === undefined || (id === undefined && connected.length > 1)) {
          throw new Error('2 different projects are connected. Pass sessionId to target one.');
        }
        return found as unknown as ReturnType<SessionManager['resolve']>;
      },
    };
    return {
      fs,
      reticleRoot: rootA,
      flows: new FlowStore(fs, rootA, { now: () => 0 }),
      sessions: sessions as SessionManager,
      now: () => 0,
      artifactRootFor: (projectId: unknown, origin?: string) => {
        if (projectId === GONE) {
          return { root: rootUnmatched };
        }
        if (origin === WORKTREE_ORIGIN) {
          return { root: rootWorktree };
        }
        return { root: projectId === B ? rootB : rootA };
      },
    } as unknown as ToolDeps;
  }

  const affected = async (d: ToolDeps, args: Record<string, unknown>) => {
    const tool = AFFECTED_TOOLS.find((t) => t.name === ReticleTool.AFFECTED);
    if (tool === undefined) {
      throw new Error('no affected tool');
    }
    return (await tool.handler(d, { files: ['src/App.tsx'], ...args })) as {
      affected: string[];
      unknownProvenance: string[];
      note?: string;
    };
  };

  const a = { id: 's-a', url: 'http://localhost:5173/', projectId: A };
  const b = { id: 's-b', url: 'http://localhost:3000/', projectId: B };

  it('gives only the driven project flows when two projects are connected', async () => {
    const result = await affected(deps([a, b]), { sessionId: 's-b' });
    expect(result.affected).toContain('flow-of-b');
    expect(result.affected).not.toContain('flow-of-a');
  });

  it('refuses when two projects are connected and no session is named', async () => {
    await expect(affected(deps([a, b]), {})).rejects.toThrow(/Pass sessionId/);
  });

  it('still answers for the one connected session when none is named', async () => {
    expect((await affected(deps([b]), {})).affected).toContain('flow-of-b');
  });

  it('still answers from the daemon root when nothing is connected', async () => {
    expect((await affected(deps([]), {})).affected).toContain('flow-of-a');
  });

  it('resolves a tab served from a worktree to that worktree', async () => {
    const tab = { id: 's-w', url: `${WORKTREE_ORIGIN}/`, projectId: A };
    const result = await affected(deps([a, tab]), { sessionId: 's-w' });
    expect(result.affected).toEqual(['flow-of-worktree']);
  });

  it('says a project with no folder has no flows, and names where its evidence goes', async () => {
    const tab = { id: 's-u', url: 'http://localhost:4000/', projectId: GONE };
    const result = await affected(deps([a, tab]), { sessionId: 's-u', since: 'HEAD~1' });
    expect(result.affected).toEqual([]);
    expect(result.note).toContain('no flows');
    expect(result.note).toContain(join('unmatched', GONE));
    expect(result.note).not.toMatch(/could not read the diff/);
  });

  it('refuses a named session that does not exist', async () => {
    await expect(affected(deps([a, b]), { sessionId: 's-gone' })).rejects.toThrow(
      /names no session/,
    );
  });
});
