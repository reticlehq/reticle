/**
 * Replay waits for a page to hydrate before a step acts on it (#1654).
 *
 * A Next page with `@reticlehq/react` connects before a slow Suspense boundary hydrates. Queries
 * answer and the server-rendered button is there, but React has not attached its handler. Step 1
 * clicked it, nothing happened, and the step's `expect` failed on a correct app.
 *
 * The fake page below hydrates on a COUNT of store reads, never on a timer, so each result here is
 * the same on a loaded machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ActionType,
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  FlowStepTool,
  HydrationState,
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
import { removeTempDirSync } from '@/machine/temp-dir.test-helpers.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import { CommandTimeoutError } from '@/portal/session/page-commands/pending-commands.js';
import { SESSION_DISCONNECTED_REASON } from '@/portal/session/facts/session-replaced.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { FlowStore } from '../flows.js';
import { replayNamedFlow } from '../flow-replay-run.js';
import { HYDRATION_WAIT_MS, awaitHydration, hydrationBudgetMs } from './hydration-wait.js';

const FLOW_NAME = 'reveal';
const BUTTON = 'reveal';
const REVEALED = 'revealed';
/** The store read on which the fake page hydrates. */
const HYDRATES_ON_READ = 3;
const BUSY = 'the page did not answer in time';

interface SlowPageOptions {
  /** False: no React adapter on the page, so no render store to read. */
  adapter?: boolean;
  /** What the store says until the page hydrates. */
  state?: HydrationState;
  /** The store read on which the page hydrates. Undefined: it never does by itself. */
  hydratesOnRead?: number;
  /** How many store reads time out first, as on a main thread busy loading a bundle. */
  busyReads?: number;
  /** The store read from which every read times out, as on a page that said pending and got busy. */
  busyFromRead?: number;
  /** The click after which the page hydrates, as a page does while a failed step waits. */
  hydratesAfterAct?: number;
  /** The click after which every store read times out, as on a main thread that got busy. */
  busyAfterAct?: number;
  /** True: the page refuses a navigation, so a `navigate` step fails at once. */
  refusesNavigate?: boolean;
  /** Where the page is. */
  url?: string;
}

/** A page whose React adapter reports `hydration`, and whose button works only once it is done. */
class SlowPage {
  state: HydrationState;
  revealed = false;
  reads = 0;
  readonly commands: string[] = [];
  readonly timeouts: (number | undefined)[] = [];
  /** Set to make NAVIGATE unload this page; the next page is then `navigatesTo`. */
  navigatesTo: SlowPage | undefined;
  readonly url: string;
  private readonly events: ReticleEvent[] = [];
  private busy: number;
  private acts = 0;

  constructor(private readonly options: SlowPageOptions = {}) {
    this.state = options.state ?? HydrationState.PENDING;
    this.busy = options.busyReads ?? 0;
    this.url = options.url ?? 'http://localhost:15999/';
  }

  hydrate(): void {
    this.state = HydrationState.DONE;
    this.events.push({
      t: 1,
      type: EventType.SIGNAL,
      sessionId: 'tab',
      data: { name: RETICLE_HYDRATION_SIGNAL, data: {} },
    });
  }

  session(): Session {
    const page: Partial<Session> = {
      id: 'tab',
      url: this.url,
      command: (name, args = {}, timeoutMs): Promise<CommandResult> => {
        this.commands.push(name);
        if (ReticleCommand.STATE_READ === name) {
          this.timeouts.push(timeoutMs);
          this.reads += 1;
          const busyNow =
            this.options.busyAfterAct !== undefined && this.acts >= this.options.busyAfterAct;
          const busyLate =
            this.options.busyFromRead !== undefined && this.reads >= this.options.busyFromRead;
          if (busyNow || busyLate || this.busy > 0) {
            this.busy -= 1;
            return Promise.reject(new CommandTimeoutError(BUSY));
          }
          if (this.reads === this.options.hydratesOnRead) {
            this.hydrate();
          }
        }
        if (ReticleCommand.NAVIGATE === name && this.navigatesTo !== undefined) {
          return Promise.reject(new Error(SESSION_DISCONNECTED_REASON));
        }
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
    return page as Session;
  }

  private answer(name: string, args: Record<string, unknown>): unknown {
    if (ReticleCommand.STATE_READ === name) {
      const found =
        false !== this.options.adapter &&
        RETICLE_RENDERS_STORE === args['store'] &&
        RenderStatsField.HYDRATION === args['path'];
      return { store: args['store'], path: args['path'], found, value: found ? this.state : null };
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
      this.revealed = this.revealed || HydrationState.PENDING !== this.state;
      this.acts += 1;
      if (this.acts === this.options.hydratesAfterAct) {
        this.hydrate();
      }
      return {};
    }
    if (ReticleCommand.MATCH === name) {
      const elements = this.revealed
        ? [{ ref: asRef('e-2'), role: 'paragraph', name: REVEALED, states: [], visible: true }]
        : [];
      return { matched: this.revealed, count: elements.length, elements };
    }
    if (ReticleCommand.NAVIGATE === name) {
      return { ok: true !== this.options.refusesNavigate };
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
    const page = new SlowPage();
    page.hydrate();
    const clock = fakeClock();

    const wait = await awaitHydration(page.session(), clock, HYDRATION_WAIT_MS);

    expect(wait).toBeUndefined();
    expect(page.commands).toEqual([]);
    expect(clock.slept).toEqual([]);
  });

  it('does not take a signal from an older document as this page hydrated', async () => {
    const page = new SlowPage({ hydratesOnRead: HYDRATES_ON_READ });
    const stale: ReticleEvent = {
      t: 1,
      type: EventType.SIGNAL,
      sessionId: 'tab',
      documentId: 'doc-old',
      data: { name: RETICLE_HYDRATION_SIGNAL, data: {} },
    };
    const session = page.session();
    const reloaded = {
      command: session.command.bind(session),
      eventsSince: () => [stale],
      currentDocumentId: 'doc-new',
    };

    expect(await awaitHydration(reloaded, fakeClock(), HYDRATION_WAIT_MS)).toBeUndefined();
    expect(page.reads).toBe(HYDRATES_ON_READ);
  });

  it('does not wait when the page has no React adapter', async () => {
    const page = new SlowPage({ adapter: false });
    const clock = fakeClock();

    expect(await awaitHydration(page.session(), clock, HYDRATION_WAIT_MS)).toBeUndefined();
    expect(clock.slept).toEqual([]);
  });

  // #1654 audit: the adapter is installed on pages with no React tree (Preact, an Astro page
  // without a React island, a static Vite entry). The store said "not hydrated" there for ever, and
  // replay waited its whole bound on every flow: a 24-flow suite ran past its 240 s budget.
  it.each([HydrationState.NONE, HydrationState.UNKNOWN, HydrationState.DONE])(
    'does not wait when the adapter says %s',
    async (state) => {
      const page = new SlowPage({ state });
      const clock = fakeClock();

      expect(await awaitHydration(page.session(), clock, HYDRATION_WAIT_MS)).toBeUndefined();
      expect(clock.slept).toEqual([]);
      expect(page.reads).toBe(1);
    },
  );

  it('waits while the page says pending, and reports nothing when it hydrates', async () => {
    const page = new SlowPage({ hydratesOnRead: HYDRATES_ON_READ });
    const clock = fakeClock();

    expect(await awaitHydration(page.session(), clock, HYDRATION_WAIT_MS)).toBeUndefined();
    expect(page.reads).toBe(HYDRATES_ON_READ);
  });

  it('stops at the bound, and says that the page still said pending', async () => {
    const page = new SlowPage();
    const clock = fakeClock();

    const wait = await awaitHydration(page.session(), clock, HYDRATION_WAIT_MS);

    expect(wait).toEqual({
      waitedMs: HYDRATION_WAIT_MS,
      budgetMs: HYDRATION_WAIT_MS,
      stillPending: true,
    });
  });

  it('never gives one read more time than the bound has left', async () => {
    const page = new SlowPage();
    const clock = fakeClock();

    await awaitHydration(page.session(), clock, HYDRATION_WAIT_MS);

    expect(page.timeouts.every((ms) => ms !== undefined && ms <= HYDRATION_WAIT_MS)).toBe(true);
    expect(page.timeouts[0]).toBe(HYDRATION_WAIT_MS);
  });

  // #1654 audit: a read that timed out was taken as "hydrated", so a page whose main thread was busy
  // (the issue's large bundle or CPU throttling) got no wait at all.
  it('keeps waiting when the page is too busy to answer, and goes on when it hydrates', async () => {
    const page = new SlowPage({ busyReads: 2, hydratesOnRead: 4 });
    const clock = fakeClock();

    expect(await awaitHydration(page.session(), clock, HYDRATION_WAIT_MS)).toBeUndefined();
    expect(page.reads).toBe(4);
  });

  it('says at the bound when the page never answered, and does not call it pending', async () => {
    const page = new SlowPage({ busyReads: Number.MAX_SAFE_INTEGER });
    const clock = fakeClock();

    const wait = await awaitHydration(page.session(), clock, HYDRATION_WAIT_MS);

    expect(wait?.stillPending).toBe(false);
    expect(wait?.budgetMs).toBe(HYDRATION_WAIT_MS);
  });

  // The last read before the bound gets only the time that is left, which can be 1 ms. When it timed
  // out, the earlier `pending` answers were lost, and a step on a page that never hydrated was
  // reported as a real failure. Seen in CI as a flaky replay-hydration e2e spec.
  it('says pending at the bound when the page said pending and then stopped answering', async () => {
    const page = new SlowPage({ busyFromRead: 2 });
    const clock = fakeClock();

    const wait = await awaitHydration(page.session(), clock, HYDRATION_WAIT_MS);

    expect(wait?.stillPending).toBe(true);
    expect(wait?.budgetMs).toBe(HYDRATION_WAIT_MS);
  });

  it('lets a page that went away reach step 1, which reports it', async () => {
    const gone = {
      command: () => Promise.reject(new Error(SESSION_DISCONNECTED_REASON)),
      eventsSince: () => [],
    };

    expect(await awaitHydration(gone, fakeClock(), HYDRATION_WAIT_MS)).toBeUndefined();
  });

  it('does not hide any other error as a hydrated page', async () => {
    const broken = {
      command: () => Promise.reject(new Error('bridge fault')),
      eventsSince: () => [],
    };

    await expect(awaitHydration(broken, fakeClock(), HYDRATION_WAIT_MS)).rejects.toThrow(
      'bridge fault',
    );
  });
});

describe('hydrationBudgetMs', () => {
  it('is the flow budget when the flow gives its first step more time, and never less than the floor', () => {
    expect(hydrationBudgetMs(1_000)).toBe(HYDRATION_WAIT_MS);
    expect(hydrationBudgetMs(HYDRATION_WAIT_MS * 3)).toBe(HYDRATION_WAIT_MS * 3);
  });
});

let base = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-replay-hydration-')));
  mkdirSync(join(base, '.reticle'), { recursive: true });
});

afterEach(() => {
  removeTempDirSync(base);
});

const clickStep = {
  tool: ReticleTool.ACT,
  anchor: { kind: AnchorKind.TESTID, value: BUTTON },
  action: ActionType.CLICK,
  expect: { kind: 'element', query: { testid: REVEALED } },
} as const;

/** The same click with no `expect`: it passes whatever the page does. */
const bareClick = { tool: clickStep.tool, anchor: clickStep.anchor, action: clickStep.action };

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: FLOW_NAME,
  createdAt: 0,
  steps: [clickStep],
};

/** Replay `saved` on `start`. `sessions` follows a navigation to the page it opens. */
async function replayOn(
  start: SlowPage,
  saved: FlowFile = flow,
  now: () => number = () => Date.now(),
) {
  const fs = createNodeFileSystem();
  const root = join(base, '.reticle');
  await new FlowStore(fs, root, { now: () => 0 }).saveFlow(saved);
  let current = start;
  let session = start.session();
  const resolve = (): Session => {
    const next = current.navigatesTo;
    if (next !== undefined && start.commands.includes(ReticleCommand.NAVIGATE)) {
      current = next;
      session = next.session();
      start.navigatesTo = undefined;
    }
    return session;
  };
  const sessions: Partial<SessionManager> = { count: () => 1, resolve };
  const deps = {
    fs,
    now,
    reticleRoot: join(base, 'daemon'),
    flows: new FlowStore(fs, join(base, 'daemon'), { now: () => 0 }),
    sessions: sessions as SessionManager,
    artifactRootFor: () => ({ root, reason: ArtifactRootReason.MATCHED_PROJECT }),
  } as unknown as ToolDeps;
  return replayNamedFlow(deps, { flowName: saved.name });
}

/** A clock for `deps.now` that moves a second on every read, so a bound runs out in a few polls. */
function racingClock(): () => number {
  let t = 0;
  return () => (t += 1_000);
}

/**
 * A replay that fails its step waits out the step's real `expect` budget. A generous bound for a
 * loaded runner; no test here asserts a duration.
 */
const REPLAY_TIMEOUT_MS = 30_000;

describe('flow replay on a page that is not hydrated yet', { timeout: REPLAY_TIMEOUT_MS }, () => {
  it('passes a step whose click needs the handler that hydration attaches', async () => {
    const page = new SlowPage({ hydratesOnRead: HYDRATES_ON_READ });

    const result = await replayOn(page);

    expect(result.steps[0]?.ok).toBe(true);
    expect(result.status).toBe(ReplayStatus.OK);
    expect(result.hydrationWait).toBeUndefined();
  });

  // #1654 audit: at the bound the replay was a plain `drift` on a correct, slow app.
  it('is unverifiable when step 1 fails on a page that was still pending at the bound', async () => {
    const page = new SlowPage();

    const result = await replayOn(page, flow, racingClock());

    expect(result.status).toBe(ReplayStatus.UNVERIFIABLE);
    const reason = result.unverifiable?.reason ?? '';
    expect(reason.indexOf('hydrate')).toBeGreaterThanOrEqual(0);
    // The hydration reason first, and the step's own reason after it (rule 11).
    expect(reason.indexOf('hydrate')).toBeLessThan(reason.indexOf(REVEALED));
    expect(result.steps[0]?.ok).toBe(false);
    expect(result.hydrationWait?.budgetMs).toBe(HYDRATION_WAIT_MS);
    expect(result.hydrationWait?.stillPending).toBe(true);
  });

  it('keeps a failure a failure when the page that did not answer cannot be called pending', async () => {
    const page = new SlowPage({ busyReads: Number.MAX_SAFE_INTEGER });

    const result = await replayOn(page, flow, racingClock());

    expect(result.status).toBe(ReplayStatus.DRIFT);
    expect(result.hydrationWait?.stillPending).toBe(false);
  });

  it('waits as long as the flow gives its first step, when that is longer than the floor', async () => {
    const page = new SlowPage();
    const patient: FlowFile = { ...flow, signalTimeoutMs: HYDRATION_WAIT_MS * 3 };

    const result = await replayOn(page, patient, racingClock());

    expect(result.hydrationWait?.budgetMs).toBe(HYDRATION_WAIT_MS * 3);
  });

  it('runs at once on a page without the React adapter', async () => {
    const page = new SlowPage({ adapter: false, state: HydrationState.DONE });

    const result = await replayOn(page);

    expect(result.status).toBe(ReplayStatus.OK);
    expect(result.hydrationWait).toBeUndefined();
  });

  it('runs at once on a page where the adapter finds no React tree', async () => {
    const page = new SlowPage({ state: HydrationState.NONE });

    const result = await replayOn(page, flow, racingClock());

    expect(result.status).toBe(ReplayStatus.OK);
    expect(result.hydrationWait).toBeUndefined();
    expect(page.reads).toBe(1);
  });

  // A `navigate` step loads a new document, which can be server-rendered and not hydrated, the same
  // as the start page. The wait ran only before step 1.
  it('waits for the page that a navigate step opens before the next step acts on it', async () => {
    const start = new SlowPage({ state: HydrationState.DONE });
    const next = new SlowPage({
      hydratesOnRead: HYDRATES_ON_READ,
      url: 'http://localhost:15999/next',
    });
    start.navigatesTo = next;
    const journey: FlowFile = {
      ...flow,
      steps: [
        {
          tool: FlowStepTool.NAVIGATE,
          anchor: { kind: AnchorKind.TESTID, value: '/next' },
          navigate: '/next',
        },
        clickStep,
      ],
    };

    const result = await replayOn(start, journey);

    expect(next.reads).toBe(HYDRATES_ON_READ);
    expect(result.steps[1]?.ok).toBe(true);
    expect(result.status).toBe(ReplayStatus.OK);
  });

  // #2269 review: a page opened by a `navigate` step that reached the bound gave `drift`. The page
  // hydrated while the failed click waited for its `expect`, and the read after the failure said
  // `done`. The state that counts is the one when the click started.
  it('is unverifiable when a click on a page that a navigate step opened started while it was pending', async () => {
    const start = new SlowPage({ state: HydrationState.DONE });
    const next = new SlowPage({ hydratesAfterAct: 1, url: 'http://localhost:15999/next' });
    start.navigatesTo = next;
    const journey: FlowFile = {
      ...flow,
      steps: [
        {
          tool: FlowStepTool.NAVIGATE,
          anchor: { kind: AnchorKind.TESTID, value: '/next' },
          navigate: '/next',
        },
        clickStep,
      ],
    };

    const result = await replayOn(start, journey, racingClock());

    expect(result.steps[1]?.ok).toBe(false);
    expect(result.status).toBe(ReplayStatus.UNVERIFIABLE);
    expect(result.unverifiable?.reason).toContain('Step 1');
  });

  it('is unverifiable when a later step on the start page started while it was pending', async () => {
    const page = new SlowPage({ hydratesAfterAct: 2 });
    const twoClicks: FlowFile = {
      ...flow,
      steps: [bareClick, clickStep],
    };

    const result = await replayOn(page, twoClicks, racingClock());

    expect(result.steps[0]?.ok).toBe(true);
    expect(result.steps[1]?.ok).toBe(false);
    expect(result.status).toBe(ReplayStatus.UNVERIFIABLE);
  });

  it('keeps a failure a failure when the step started after the page hydrated', async () => {
    const page = new SlowPage({ hydratesAfterAct: 1 });
    const broken: FlowFile = {
      ...flow,
      steps: [
        bareClick,
        { ...clickStep, expect: { kind: 'element', query: { testid: 'never-there' } } },
      ],
    };

    const result = await replayOn(page, broken, racingClock());

    expect(result.steps[1]?.ok).toBe(false);
    expect(result.status).toBe(ReplayStatus.DRIFT);
  });

  // #2269 review probe: the read after a passed step timed out, and that cleared "pending". Step 2
  // then failed on a page that had never said anything else, and the replay was a false `drift`.
  it('keeps a page pending when the read after a step does not answer', async () => {
    const page = new SlowPage({ busyAfterAct: 1 });
    const twoClicks: FlowFile = { ...flow, steps: [bareClick, clickStep] };

    const result = await replayOn(page, twoClicks, racingClock());

    expect(result.steps[0]?.ok).toBe(true);
    expect(result.steps[1]?.ok).toBe(false);
    expect(result.status).toBe(ReplayStatus.UNVERIFIABLE);
  });

  // A `navigate` or `request` step does not click the page's controls, so a page that is not
  // hydrated does not explain its failure.
  it('keeps the failure of a navigate step on a pending page as it is', async () => {
    const page = new SlowPage({ refusesNavigate: true });
    const away: FlowFile = {
      ...flow,
      steps: [
        {
          tool: FlowStepTool.NAVIGATE,
          anchor: { kind: AnchorKind.TESTID, value: '/next' },
          navigate: '/next',
        },
      ],
    };

    const result = await replayOn(page, away, racingClock());

    expect(result.steps[0]?.ok).toBe(false);
    expect(result.hydrationWait?.stillPending).toBe(true);
    expect(result.status).not.toBe(ReplayStatus.UNVERIFIABLE);
  });
});
