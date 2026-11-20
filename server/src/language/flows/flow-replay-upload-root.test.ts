/**
 * A replayed upload step reads its fixture from the session's project, not the daemon's (#1769).
 *
 * The daemon starts in checkout A. The flow and its fixture live in worktree B. Before the fix,
 * replay found the flow in B but resolved the upload path against A, so the step failed with
 * "file not found".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleCommand,
  ReticleTool,
  asRecord,
  asRef,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { FlowStore } from './flows.js';
import { replayNamedFlow } from './flow-replay-run.js';
import { removeTempDirSync } from '@/machine/temp-dir.test-helpers.js';

const FIXTURE = 'fixture.txt';
const FIXTURE_TEXT = 'from worktree B';
const FLOW_NAME = 'upload-fixture';
const TESTID = 'file';
const QUERY_RESULT = {
  elements: [{ ref: asRef('e-1'), role: 'button', name: TESTID, states: [], visible: true }],
  hint: { route: '/', presentTestids: [TESTID], knownEmptyState: false },
};

let base = '';
let daemonDir = '';
let worktreeDir = '';

beforeEach(() => {
  // realpath: on macOS the temp folder is a symlink, and the allowed-root check compares real paths.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-replay-upload-')));
  daemonDir = join(base, 'a');
  worktreeDir = join(base, 'b');
  mkdirSync(join(daemonDir, '.reticle'), { recursive: true });
  mkdirSync(join(worktreeDir, '.reticle'), { recursive: true });
  writeFileSync(join(worktreeDir, FIXTURE), FIXTURE_TEXT);
});

afterEach(() => {
  removeTempDirSync(base);
});

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: FLOW_NAME,
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.TESTID, value: TESTID },
      action: ActionType.UPLOAD,
      args: { path: FIXTURE },
    },
  ],
};

describe('flow replay resolves an upload path against the session project', () => {
  it('uploads the fixture from the worktree that holds the flow', async () => {
    const fs = createNodeFileSystem();
    const worktreeRoot = join(worktreeDir, '.reticle');
    await new FlowStore(fs, worktreeRoot, { now: () => 0 }).saveFlow(flow);

    const uploads: Record<string, unknown>[] = [];
    const session: Partial<Session> = {
      id: 'wt-b',
      url: 'http://localhost:15999/',
      command: (name, args): Promise<CommandResult> => {
        if (ReticleCommand.ACT === name) uploads.push(asRecord(asRecord(args)['args']));
        const result = ReticleCommand.QUERY === name ? QUERY_RESULT : {};
        return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
      },
      elapsed: () => 0,
      eventsSince: () => [],
      onEvent: () => () => undefined,
    };
    const sessions: Partial<SessionManager> = { resolve: () => session as Session };
    const deps = {
      fs,
      now: () => 0,
      reticleRoot: join(daemonDir, '.reticle'),
      flows: new FlowStore(fs, join(daemonDir, '.reticle'), { now: () => 0 }),
      sessions: sessions as SessionManager,
      artifactRootFor: () => ({ root: worktreeRoot, reason: ArtifactRootReason.MATCHED_PROJECT }),
    } as unknown as ToolDeps;

    const result = await replayNamedFlow(deps, { flowName: FLOW_NAME });

    expect(result.error).toBeUndefined();
    const content = uploads[0]?.['content'];
    expect(Buffer.from(String(content), 'base64').toString()).toBe(FIXTURE_TEXT);
  });
});
