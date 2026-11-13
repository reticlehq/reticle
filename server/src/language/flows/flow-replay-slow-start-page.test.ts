/**
 * #2155: `reticle verify` replays on the tab it drives itself, not on a pool lease.
 *
 * Replay navigates that tab to the flow's start page. On a dev server that compiles the module that
 * dials Reticle for about 12 s, the SDK connects after the 5 s step budget. Replay asked only a pool
 * lease whether its page was still loading, so the driven tab had no probe, and replay stopped at
 * 5 s with "no page was connected". Nothing ran.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleCommand,
  ReticleTool,
  asRef,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import type { RealInputProvider } from '@/portal/input/real-input.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { FlowStore } from './flows.js';
import { replayNamedFlow } from './flow-replay-run.js';

const FLOW_NAME = 'builder';
const BUTTON = 'go';
const ORIGIN = 'http://localhost:14792';
/** When the dev server answers the module that dials, after the navigation. */
const COMPILE_MS = 12_000;
const LOST = 'no page was connected';
/** Fake time moves in this step while real I/O (the flow file read) gets a turn. */
const TICK_MS = 50;
/** A generous ceiling for the whole test: real I/O runs between the fake ticks. */
const REPLAY_TIMEOUT_MS = 30_000;

const QUERY_RESULT = {
  elements: [{ ref: asRef('e-1'), role: 'button', name: BUTTON, states: [], visible: true }],
  hint: { route: '/builder', presentTestids: [], knownEmptyState: false },
};

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: FLOW_NAME,
  createdAt: 0,
  startPath: '/builder',
  steps: [
    {
      tool: ReticleTool.ACT,
      // A role anchor: only a testid or component lets replay start on another page.
      anchor: { kind: AnchorKind.ROLE, role: 'button', name: BUTTON },
      action: ActionType.CLICK,
    },
  ],
};

let base = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-slow-start-')));
  mkdirSync(join(base, '.reticle'), { recursive: true });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(base, { recursive: true, force: true });
});

function tab(id: string, url: string, onCommand: (name: string) => void): Partial<Session> {
  return {
    id,
    url,
    command: (name): Promise<CommandResult> => {
      onCommand(name);
      const result = ReticleCommand.QUERY === name ? QUERY_RESULT : { ok: true };
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    elapsed: () => 0,
    eventsSince: () => [],
    onEvent: () => () => undefined,
  };
}

/** Run `work` on fake time, and give real I/O a turn between steps. */
async function onFakeTime<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const settled = work.finally(() => {
    done = true;
  });
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(TICK_MS);
  }
  return settled;
}

describe('replay on the tab that reticle verify drives (#2155)', () => {
  it(
    'waits for a start page whose dev server compiles past the step budget',
    async () => {
      const fs = createNodeFileSystem();
      const root = join(base, '.reticle');
      await new FlowStore(fs, root, { now: () => 0 }).saveFlow(flow);

      let navigatedAt: number | undefined;
      const acts: string[] = [];
      const record = (name: string): void => {
        if (ReticleCommand.NAVIGATE === name) {
          navigatedAt = Date.now();
        }
        if (ReticleCommand.ACT === name) {
          acts.push(name);
        }
      };
      const home = tab('home', `${ORIGIN}/`, record);
      const builder = tab('builder', `${ORIGIN}/builder`, record);
      const compiled = (): boolean =>
        navigatedAt !== undefined && COMPILE_MS <= Date.now() - navigatedAt;
      const sessions: Partial<SessionManager> = {
        count: () => 1,
        resolve: () => (compiled() ? builder : home) as Session,
      };
      // The driven tab: its document is complete, and the module that dials is still open.
      const realInput = {
        isAvailableFor: () => Promise.resolve(true),
        perform: () => Promise.resolve({ ok: true }),
        drivenPageLoading: () => Promise.resolve(navigatedAt !== undefined && !compiled()),
      } as unknown as RealInputProvider;
      const deps = {
        fs,
        now: () => Date.now(),
        reticleRoot: join(base, 'daemon'),
        flows: new FlowStore(fs, join(base, 'daemon'), { now: () => 0 }),
        sessions: sessions as SessionManager,
        realInput,
        artifactRootFor: () => ({ root, reason: ArtifactRootReason.MATCHED_PROJECT }),
      } as unknown as ToolDeps;

      const result = await onFakeTime(replayNamedFlow(deps, { flowName: FLOW_NAME }));

      expect(result.unverifiable?.reason ?? '').not.toContain(LOST);
      expect(result.startPageWait?.stillLoading).toBe(true);
      // A bound, not a duration: past the 5 s budget, and under the 30 s cap.
      expect(result.startPageWait?.waitedMs).toBeGreaterThan(result.startPageWait?.budgetMs ?? 0);
      expect(result.startPageWait?.waitedMs).toBeLessThan(30_000);
      expect(acts).toHaveLength(1);
    },
    REPLAY_TIMEOUT_MS,
  );
});
