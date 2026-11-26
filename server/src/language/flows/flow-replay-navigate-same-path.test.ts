/**
 * A `navigate` step that opens the path the tab is already on, with another query (#2526).
 *
 * The tab is on `/hydrate` and the step opens `/hydrate?delay=2000`. The page that asked for the
 * load is still connected for a moment, on `/hydrate`, before it unloads. Replay compared the old
 * page's path with the step's path without the query, read the old page as "arrived", and the next
 * step acted on a page that was going away, so it timed out. Only a new page counts as arrived.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  FlowStepTool,
  ReticleCommand,
  ReticleTool,
  asRef,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { removeTempDirSync } from '@/machine/temp-dir.test-helpers.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import type { RealInputProvider } from '@/portal/input/real-input.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { FlowStore } from './flows.js';
import { replayNamedFlow } from './flow-replay-run.js';
import { onPathAlready } from './flow-start-path.js';

const ORIGIN = 'http://localhost:14793';
const BUTTON = 'go';
/** How long the page that asked for the load stays connected before the new page replaces it. */
const UNLOAD_MS = 500;
const TICK_MS = 50;
const REPLAY_TIMEOUT_MS = 30_000;

const QUERY_RESULT = {
  elements: [{ ref: asRef('e-1'), role: 'button', name: BUTTON, states: [], visible: true }],
  hint: { route: '/hydrate', presentTestids: [], knownEmptyState: false },
};

function flowOpening(navigate: string): FlowFile {
  return {
    version: FLOW_FILE_VERSION,
    name: 'reopen-hydrate',
    createdAt: 0,
    steps: [
      {
        tool: FlowStepTool.NAVIGATE,
        anchor: { kind: AnchorKind.TESTID, value: navigate },
        navigate,
      },
      {
        tool: ReticleTool.ACT,
        anchor: { kind: AnchorKind.TESTID, value: BUTTON },
        action: ActionType.CLICK,
      },
    ],
  };
}

let base = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-same-path-')));
  mkdirSync(join(base, '.reticle'), { recursive: true });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  removeTempDirSync(base);
});

function tab(id: string, url: string, onCommand: (id: string, name: string) => void): Session {
  return {
    id,
    url,
    command: (name: string): Promise<CommandResult> => {
      onCommand(id, name);
      const result = ReticleCommand.QUERY === name ? QUERY_RESULT : { ok: true };
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    elapsed: () => 0,
    eventsSince: () => [],
    onEvent: () => () => undefined,
  } as unknown as Session;
}

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

/** Replays `saved` on a tab at `from`; the page the step opens connects at `to` after `unloadMs`. */
async function replayFrom(
  saved: FlowFile,
  from: string,
  to: string,
  unloadMs = UNLOAD_MS,
): Promise<{ result: Awaited<ReturnType<typeof replayNamedFlow>>; actedOn: string[] }> {
  const fs = createNodeFileSystem();
  const root = join(base, '.reticle');
  await new FlowStore(fs, root, { now: () => 0 }).saveFlow(saved);

  let navigatedAt: number | undefined;
  const actedOn: string[] = [];
  const record = (id: string, name: string): void => {
    if (ReticleCommand.NAVIGATE === name) {
      navigatedAt = Date.now();
    }
    if (ReticleCommand.ACT === name) {
      actedOn.push(id);
    }
  };
  const before = tab('before', `${ORIGIN}${from}`, record);
  const after = tab('after', `${ORIGIN}${to}`, record);
  const unloaded = (): boolean => navigatedAt !== undefined && unloadMs <= Date.now() - navigatedAt;
  const sessions: Partial<SessionManager> = {
    count: () => 1,
    resolve: () => (unloaded() ? after : before),
  };
  const realInput = {
    isAvailableFor: () => Promise.resolve(true),
    perform: () => Promise.resolve({ ok: true }),
    drivenPageLoading: () => Promise.resolve(false),
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

  const result = await onFakeTime(replayNamedFlow(deps, { flowName: saved.name }));
  return { result, actedOn };
}

describe('a navigate step to the path the tab is already on (#2526)', () => {
  it(
    'acts on the page that loads when only the query differs',
    async () => {
      const { result, actedOn } = await replayFrom(
        flowOpening('/hydrate?delay=2000'),
        '/hydrate',
        '/hydrate?delay=2000',
      );

      expect(result.steps[0]?.ok).toBe(true);
      expect(actedOn).toEqual(['after']);
    },
    REPLAY_TIMEOUT_MS,
  );

  it(
    'acts on the page that loads when the step reloads the same URL',
    async () => {
      const { actedOn } = await replayFrom(flowOpening('/hydrate'), '/hydrate', '/hydrate');

      expect(actedOn).toEqual(['after']);
    },
    REPLAY_TIMEOUT_MS,
  );

  it(
    'fails the step, and does not act on the old page, when the old page never unloads',
    async () => {
      const { result, actedOn } = await replayFrom(
        flowOpening('/hydrate?delay=2000'),
        '/hydrate',
        '/hydrate?delay=2000',
        Number.POSITIVE_INFINITY,
      );

      expect(result.steps[0]?.ok).toBe(false);
      expect(result.steps[0]?.error).toContain('/hydrate?delay=2000');
      expect(actedOn).toEqual([]);
    },
    REPLAY_TIMEOUT_MS,
  );

  it(
    'still acts on the page that loads when the step opens another path',
    async () => {
      const { result, actedOn } = await replayFrom(
        flowOpening('/settings'),
        '/hydrate',
        '/settings',
      );

      expect(result.steps[0]?.ok).toBe(true);
      expect(actedOn).toEqual(['after']);
    },
    REPLAY_TIMEOUT_MS,
  );
});

describe('onPathAlready', () => {
  const at = (url: string | undefined) => ({
    ...(url === undefined ? {} : { url }),
    eventsSince: () => [],
  });

  it('is true on the same path, with or without a query on either side', () => {
    expect(onPathAlready(at(`${ORIGIN}/hydrate`), '/hydrate')).toBe(true);
    expect(onPathAlready(at(`${ORIGIN}/hydrate?delay=1`), '/hydrate')).toBe(true);
    expect(onPathAlready(at(`${ORIGIN}/hydrate/`), '/hydrate')).toBe(true);
  });

  it('is false on another path, or when the route is not known', () => {
    expect(onPathAlready(at(`${ORIGIN}/settings`), '/hydrate')).toBe(false);
    expect(onPathAlready(at(`${ORIGIN}/hydrate-old`), '/hydrate')).toBe(false);
    expect(onPathAlready(at(undefined), '/hydrate')).toBe(false);
  });
});
