/**
 * An upload `path` resolves against the session's project, not the daemon's folder (#1769).
 *
 * The daemon starts in checkout A. The page comes from worktree B. A relative fixture path that
 * exists only in B must upload from B. Before the fix, the path resolved against A, so the upload
 * was refused as "file not found" or as outside every allowed root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActionType, asRecord, type CommandResult } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { actCommand } from './act-tools.js';
import type { ToolDeps } from './tools.js';

const FIXTURE = 'fixture.txt';
const FIXTURE_TEXT = 'from worktree B';

let base = '';
let daemonDir = '';
let worktreeDir = '';

beforeEach(() => {
  // realpath: on macOS the temp folder is a symlink, and the allowed-root check compares real paths.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-upload-root-')));
  daemonDir = join(base, 'a');
  worktreeDir = join(base, 'b');
  mkdirSync(join(daemonDir, '.reticle'), { recursive: true });
  mkdirSync(join(worktreeDir, '.reticle'), { recursive: true });
  writeFileSync(join(worktreeDir, FIXTURE), FIXTURE_TEXT);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function harness(projectDir = worktreeDir): {
  deps: ToolDeps;
  session: Session;
  sent: () => Record<string, unknown>;
} {
  let sentArgs: Record<string, unknown> = {};
  const session: Partial<Session> = {
    id: 'wt-b',
    url: 'http://localhost:15999/',
    command: (_cmd, args): Promise<CommandResult> => {
      sentArgs = asRecord(asRecord(args)['args']);
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
    },
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  const deps = {
    fs: createNodeFileSystem(),
    reticleRoot: join(daemonDir, '.reticle'),
    sessions: sessions as SessionManager,
    artifactRootFor: () => ({
      root: join(projectDir, '.reticle'),
      reason: ArtifactRootReason.MATCHED_PROJECT,
    }),
  } as unknown as ToolDeps;
  return { deps, session: session as Session, sent: () => sentArgs };
}

describe('upload path resolves against the session project', () => {
  it('uploads a relative fixture that exists only in the session worktree', async () => {
    const { deps, session, sent } = harness();
    await actCommand(deps, session, { action: ActionType.UPLOAD, args: { path: FIXTURE } });
    const content = sent()['content'];
    expect(typeof content).toBe('string');
    expect(Buffer.from(String(content), 'base64').toString()).toBe(FIXTURE_TEXT);
  });

  it('still refuses a path outside the session project', async () => {
    const { deps, session } = harness();
    writeFileSync(join(daemonDir, FIXTURE), 'daemon copy');
    await expect(
      actCommand(deps, session, {
        action: ActionType.UPLOAD,
        args: { path: join(daemonDir, FIXTURE) },
      }),
    ).rejects.toThrow(/outside every allowed upload root/);
  });

  // The project root can reach the daemon under a second spelling: a symlink here, a Windows 8.3
  // short name (`RUNNER~1`) on a CI runner. realpath turned the fixture into the long spelling while
  // the root kept the short one, so the upload was refused as outside every allowed root.
  it('uploads when the project root is reached through a second spelling', async () => {
    const link = join(base, 'link-to-b');
    symlinkSync(worktreeDir, link, 'dir');
    const { deps, session, sent } = harness(link);
    await actCommand(deps, session, { action: ActionType.UPLOAD, args: { path: FIXTURE } });
    expect(Buffer.from(String(sent()['content']), 'base64').toString()).toBe(FIXTURE_TEXT);
  });
});
