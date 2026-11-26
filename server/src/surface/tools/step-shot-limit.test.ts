import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleTool, STEP_SCREENSHOT, SessionState } from '@reticlehq/core';
import { RUN_FULL } from '@/features/visual/step-shots.js';
import { driveRunId } from '@/judgement/runs/drive-run.js';
import { removeTempDir } from '@/machine/temp-dir.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { runTool } from './invoke-tool.js';
import { EnvelopeKey, type ToolDef, type ToolDeps } from './tool-kit.js';

/**
 * A long drive reaches the per-run screenshot limit. The picture is lost, never the verdict: the
 * error on the screenshot says so, and the check still answers.
 */
describe('a check past the per-run screenshot limit', () => {
  it('still answers its verdict, and the screenshot says why it is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'step-shot-limit-'));
    try {
      const session = {
        id: 'tab-full',
        url: 'http://localhost:5173/',
        artifactRoot: root,
        command: () => Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} }),
        isEnded: () => false,
        getState: () => SessionState.ACTIVE,
        eventsSince: () => [],
        queryEvents: () => Promise.resolve([]),
        bufferHealth: () => ({ total: 0, dropped: 0 }),
        blindSpots: () => ({}),
        health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
        drainInbox: () => [],
        takeSessionLease: () => undefined,
        ageWarning: () => undefined,
      } as unknown as Session;
      // A run that already holds the most one run keeps.
      const full = join(root, 'visual', 'runs', driveRunId(session.id));
      await mkdir(full, { recursive: true });
      await writeFile(
        join(full, STEP_SCREENSHOT.MANIFEST_FILE),
        `${JSON.stringify({ seq: STEP_SCREENSHOT.MAX_PER_RUN })}\n`,
      );
      const sessions: Partial<SessionManager> = {
        resolve: () => session,
        list: () => [{ sessionId: session.id }] as ReturnType<SessionManager['list']>,
      };
      const deps = {
        sessions: sessions as SessionManager,
        fs: createNodeFileSystem(),
        reticleRoot: root,
        now: () => 0,
      } as unknown as ToolDeps;
      const assert: ToolDef = {
        name: ReticleTool.ASSERT,
        description: '',
        inputSchema: {},
        handler: () => Promise.resolve({ verified: 'yes', pass: true }),
      };

      const result = (await runTool(assert, deps, {})) as Record<string, unknown>;

      expect(result).toMatchObject({ verified: 'yes', pass: true });
      expect(result[EnvelopeKey.SCREENSHOT]).toEqual({ error: RUN_FULL });
    } finally {
      await removeTempDir(root);
    }
  });
});
