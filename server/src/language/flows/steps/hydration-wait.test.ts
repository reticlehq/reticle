/**
 * Replay waits for the page to hydrate before step 1 (#1654).
 *
 * A Next page with `@reticlehq/react` connects before a slow Suspense boundary hydrates. Queries
 * answer and the server-rendered button is there, but React has not attached its handler. Step 1
 * clicked it, nothing happened, and the step's `expect` failed on a correct app.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ActionType,
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  RETICLE_HYDRATION_SIGNAL,
  RETICLE_RENDERS_STORE,
  RenderStatsField,
  ReplayStatus,
  ReticleCommand,
  ReticleTool,
  asRef,
  asString,
  type CommandResult,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { FlowStore } from '../flows.js';
import { replayNamedFlow } from '../flow-replay-run.js';
import { HYDRATION_WAIT_MS, awaitHydration } from './hydration-wait.js';

const FLOW_NAME = 'reveal';
const BUTTON = 'reveal';
const REVEALED = 'revealed';
/** When the fake page hydrates, in real time: well inside the bound. */
const HYDRATES_AFTER_MS = 40;
/** When the fake page hydrates, in polls of the fake clock. */
const HYDRATES_AFTER_POLLS = 3;

/** A page whose React adapter reports `hydrated`, and whose button works only after hydration. */
class SlowPage {
  hydrated = false;
  revealed = false;
  readonly commands: string[] = [];
  /** `adapter` false: no React adapter on the page, so no render store to read. */
  constructor(private readonly adapter: boolean) {}
  private readonly events: ReticleEvent[] = [];

  hydrate(): void {
    this.hydrated = true;
    this.events.push({
      t: 1,
      type: EventType.SIGNAL,
      sessionId: 'tab',
      data: { name: RETICLE_HYDRATION_SIGNAL, data: {} },
    });
  }

  session(): Partial<Session> {
    return {
      id: 'tab',
      url: 'http://localhost:15999/',
      command: (name, args = {}): Promise<CommandResult> => {
        this.commands.push(name);
        return Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: this.answer(name, args),
        });
      },
      elapsed: () => 0,
      eventsSince: () => [...this.events],
      onEvent: () => () => undefined,
    };
  }

  private answer(name: string, args: Record<string, unknown>): unknown {
    if (ReticleCommand.STATE_READ === name) {
      const found =
        this.adapter &&
        RETICLE_RENDERS_STORE === args['store'] &&
        RenderStatsField.HYDRATED === args['path'];
      return {
        store: args['store'],
        path: args['path'],
        found,
        value: found ? this.hydrated : null,
      };
    }
    if (ReticleCommand.QUERY === name) {
      const present = this.revealed ? [BUTTON, REVEALED] : [BUTTON];
      const testid = asString(args['value']) ?? '';
      const elements = present.includes(testid)
        ? [{ ref: asRef(`e-${testid}`), role: 'button', name: testid, states: [], visible: true }]
        : [];
      return { elements, hint: { route: '/', presentTestids: present, knownEmptyState: false } };
    }
    if (ReticleCommand.ACT === name) {
      // Before hydration React has no handler on the button, so the click does nothing.
      this.revealed = this.revealed || this.hydrated;
      return {};
    }
    if (ReticleCommand.MATCH === name) {
      const elements = this.revealed
        ? [{ ref: asRef('e-2'), role: 'paragraph', name: REVEALED, states: [], visible: true }]
        : [];
      return { matched: this.revealed, count: elements.length, elements };
    }
    return {};
  }
}

/** A clock that a test moves, so a wait to the bound takes no real time (rule 7). */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
  };
}

describe('awaitHydration', () => {
  it('does not wait, or read the store, when the page already signalled hydration', async () => {
    const page = new SlowPage(true);
    page.hydrate();
    const clock = fakeClock();

    const wait = await awaitHydration(page.session() as Session, clock);

    expect(wait).toBeUndefined();
    expect(page.commands).toEqual([]);
    expect(clock.slept).toEqual([]);
  });

  it('does not wait when the page has no React adapter', async () => {
    const page = new SlowPage(false);
    const clock = fakeClock();

    expect(await awaitHydration(page.session() as Session, clock)).toBeUndefined();
    expect(clock.slept).toEqual([]);
  });

  it('waits until the signal comes, and reports nothing', async () => {
    const page = new SlowPage(true);
    const clock = fakeClock();
    const sleep = clock.sleep;
    clock.sleep = async (ms) => {
      await sleep(ms);
      if (HYDRATES_AFTER_POLLS === clock.slept.length) {
        page.hydrate();
      }
    };

    expect(await awaitHydration(page.session() as Session, clock)).toBeUndefined();
    expect(clock.slept).toHaveLength(HYDRATES_AFTER_POLLS);
  });

  it('stops at the bound, and says so', async () => {
    const page = new SlowPage(true);
    const clock = fakeClock();

    const wait = await awaitHydration(page.session() as Session, clock);

    expect(wait).toEqual({ waitedMs: HYDRATION_WAIT_MS, budgetMs: HYDRATION_WAIT_MS });
  });
});

let base = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-replay-hydration-')));
  mkdirSync(join(base, '.reticle'), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: FLOW_NAME,
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.TESTID, value: BUTTON },
      action: ActionType.CLICK,
      expect: { kind: 'element', query: { testid: REVEALED } },
    },
  ],
};

async function replayOn(page: SlowPage, now: () => number = () => Date.now()) {
  const fs = createNodeFileSystem();
  const root = join(base, '.reticle');
  await new FlowStore(fs, root, { now: () => 0 }).saveFlow(flow);
  const session = page.session() as Session;
  const sessions: Partial<SessionManager> = { count: () => 1, resolve: () => session };
  const deps = {
    fs,
    now,
    reticleRoot: join(base, 'daemon'),
    flows: new FlowStore(fs, join(base, 'daemon'), { now: () => 0 }),
    sessions: sessions as SessionManager,
    artifactRootFor: () => ({ root, reason: ArtifactRootReason.MATCHED_PROJECT }),
  } as unknown as ToolDeps;
  return replayNamedFlow(deps, { flowName: FLOW_NAME });
}

describe('flow replay on a page that is not hydrated yet', () => {
  it('passes a step whose click needs the handler that hydration attaches', async () => {
    const page = new SlowPage(true);
    setTimeout(() => {
      page.hydrate();
    }, HYDRATES_AFTER_MS);

    const result = await replayOn(page);

    expect(result.steps[0]?.ok).toBe(true);
    expect(result.status).toBe(ReplayStatus.OK);
    expect(result.hydrationWait).toBeUndefined();
  });

  it('says in the result when the page did not hydrate inside the bound', async () => {
    const page = new SlowPage(true);
    // Each read of the clock moves it a second, so the bound runs out after a few real polls.
    let t = 0;
    const result = await replayOn(page, () => (t += 1_000));

    expect(result.hydrationWait?.budgetMs).toBe(HYDRATION_WAIT_MS);
    expect(result.hydrationWait?.waitedMs).toBeGreaterThanOrEqual(HYDRATION_WAIT_MS);
  });

  it('runs at once on a page without the React adapter', async () => {
    const page = new SlowPage(false);
    page.hydrated = true;

    const result = await replayOn(page);

    expect(result.status).toBe(ReplayStatus.OK);
    expect(result.hydrationWait).toBeUndefined();
  });
});
