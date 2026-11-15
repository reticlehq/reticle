/**
 * Wait for a page to hydrate before a replayed step acts on it (#1654).
 *
 * With `@reticlehq/react`, the SDK can connect before React attached its handlers: Next commits the
 * shell, and a slow Suspense boundary hydrates later. Queries answer and the server-rendered button is
 * there, but a click on it does nothing, and the step's `expect` fails on a correct app.
 *
 * The adapter says what it sees: its render store reports `hydration` (`HydrationState`), and it fires
 * `reticle:hydration-complete` once the page is hydrated. Only `pending` makes replay wait. A page
 * without the adapter, with no React tree (`none`), or with a tree the adapter could not read to the
 * end (`unknown`) gives no reason to wait, and replay does not.
 *
 * Only a new document can hold a dehydrated part: React dehydrates server HTML once, when the
 * document loads, and never again. A replay loads a document in two places, the start page and a
 * `navigate` step, and `ReplayHydration` waits at both.
 */
import { z } from 'zod';
import {
  EventType,
  HydrationState,
  RETICLE_HYDRATION_SIGNAL,
  RETICLE_RENDERS_STORE,
  RenderStatsField,
  ReticleCommand,
  asString,
  type CommandResult,
  type FlowStepResult,
  type HydrationWait,
  type ReticleEvent,
} from '@reticlehq/core';
import { CommandTimeoutError } from '@/portal/session/page-commands/pending-commands.js';
import { isDocumentGoneError } from '@/portal/session/facts/session-replaced.js';

/**
 * The least time replay waits for a page to hydrate. A flow that gives its first step more time
 * waits that long instead (`hydrationBudgetMs`).
 *
 * MEASURED on next-smoke `/hydrate` in `next dev`, headless Chromium, from the SDK loading in the
 * page to the hydrated button: under 0.1 s with no throttling, 0.3 s at 6x CPU throttling, 2.5 s at
 * most at 20x, and 30 ms on a cold first load at 6x (the compile comes before the SDK loads). The
 * bound is four times the slowest of these. At the bound the replay does not fail: a step that then fails is
 * `unverifiable` (`notHydratedReason`).
 */
export const HYDRATION_WAIT_MS = 10_000;
/** How long replay sleeps between two reads while the page says `pending`. It ends no wait. */
const HYDRATION_POLL_MS = 100;

/** The bound of one hydration wait: the floor, or the flow's own start budget when that is longer. */
export function hydrationBudgetMs(startBudgetMs: number): number {
  return Math.max(HYDRATION_WAIT_MS, startBudgetMs);
}

/** The scoped store read's answer (`readState` with a `path`). */
const HydrationReadSchema = z.object({ found: z.boolean(), value: z.unknown() });

/** What one read of the page said. */
export const HydrationRead = {
  /** The adapter said `pending`: a part of the page has no handlers yet. */
  PENDING: 'pending',
  /** The page did not answer in time. Not a hydrated page: a busy main thread answers late. */
  UNANSWERED: 'unanswered',
  /** Nothing says to wait: no adapter, no React tree, a hydrated tree, or the page is gone. */
  NO_WAIT: 'no-wait',
} as const;
export type HydrationRead = (typeof HydrationRead)[keyof typeof HydrationRead];

/** The part of a replay session that the wait uses. */
export interface HydrationSession {
  command(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<CommandResult>;
  eventsSince(cursor: number): ReticleEvent[];
}

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function signalled(session: HydrationSession): boolean {
  return session
    .eventsSince(0)
    .some(
      (event) =>
        EventType.SIGNAL === event.type &&
        RETICLE_HYDRATION_SIGNAL === asString(event.data['name']),
    );
}

/** Ask the page once. `timeoutMs` absent: the session's default bound for a command. */
export async function readHydration(
  session: HydrationSession,
  timeoutMs?: number,
): Promise<HydrationRead> {
  let reply: CommandResult;
  try {
    reply = await session.command(
      ReticleCommand.STATE_READ,
      { store: RETICLE_RENDERS_STORE, path: RenderStatsField.HYDRATION },
      timeoutMs,
    );
  } catch (error: unknown) {
    if (error instanceof CommandTimeoutError) {
      return HydrationRead.UNANSWERED;
    }
    // The page went away. The next step meets the same fact and reports it as a lost document.
    if (isDocumentGoneError(error)) {
      return HydrationRead.NO_WAIT;
    }
    throw error;
  }
  if (!reply.ok) {
    // No render store: the page has no React adapter.
    return HydrationRead.NO_WAIT;
  }
  const read = HydrationReadSchema.safeParse(reply.result);
  // An older adapter has no `hydration` field (`found: false`). Then nothing says to wait.
  const pending = read.success && read.data.found && HydrationState.PENDING === read.data.value;
  return pending ? HydrationRead.PENDING : HydrationRead.NO_WAIT;
}

/**
 * Wait, up to `budgetMs`, while the page says `pending` or does not answer.
 *
 * Returns undefined when nothing said to wait, or the page hydrated inside the bound. Returns the
 * wait when the bound ran out, so the result can say that a step ran on a page that may not be
 * hydrated.
 */
export async function awaitHydration(
  session: HydrationSession,
  clock: Clock,
  budgetMs: number,
): Promise<HydrationWait | undefined> {
  const started = clock.now();
  let last: HydrationRead | undefined;
  for (;;) {
    // The signal can fire before replay starts. Then the page is ready and nothing is asked.
    if (signalled(session)) {
      return undefined;
    }
    const waitedMs = clock.now() - started;
    if (last !== undefined && waitedMs >= budgetMs) {
      return { waitedMs, budgetMs, stillPending: HydrationRead.PENDING === last };
    }
    // No read gets more time than the bound has left, so a busy page cannot stretch the wait.
    last = await readHydration(session, Math.max(1, budgetMs - waitedMs));
    if (HydrationRead.NO_WAIT === last) {
      return undefined;
    }
    const after = clock.now() - started;
    if (after < budgetMs) {
      await clock.sleep(Math.min(HYDRATION_POLL_MS, budgetMs - after));
    }
  }
}

/** The reason a failed step is not a verdict: it ran on a page that was not hydrated. */
export function notHydratedReason(wait: HydrationWait, step: FlowStepResult): string {
  const said = step.drift?.reason ?? step.error ?? 'the step did not pass';
  return (
    `the page still waited for React to hydrate after ${String(wait.waitedMs)} ms ` +
    `(the bound is ${String(wait.budgetMs)} ms). Step ${String(step.step)} ran before React ` +
    `attached all of its event handlers, so its result says nothing about the app. ` +
    `Make the page hydrate sooner, or give the flow more time with signalTimeoutMs, and replay ` +
    `again. Step ${String(step.step)}: ${said}`
  );
}

/**
 * The hydration side of one replay: a wait on each page that loads, and what the first failed step
 * means when the page it ran on was known not to be hydrated.
 */
export class ReplayHydration {
  /** The wait on the live page, when it reached its bound. */
  #onPage: HydrationWait | undefined;
  /** The most recent wait that reached its bound, on any page of this replay. */
  #last: HydrationWait | undefined;
  /** Step results reported on the live page. */
  #reported = 0;
  /** Set at the first failed step: the wait of its page, when that page was known not hydrated. */
  #failed: { unhydrated?: HydrationWait } | undefined;

  constructor(
    private readonly budgetMs: number,
    private readonly clock: Clock,
  ) {}

  /** Wait for a page that just loaded, before a step acts on it. */
  async arrive(session: HydrationSession): Promise<void> {
    this.#onPage = await awaitHydration(session, this.clock, this.budgetMs);
    this.#reported = 0;
    if (this.#onPage !== undefined) {
      this.#last = this.#onPage;
    }
  }

  /**
   * Note a reported step result, before the next step runs. `live` is the page it ran on.
   *
   * A failed step ran on a page known not to be hydrated when the wait on that page ended `pending`
   * and either the step was the first to run there, or the page still says `pending` now.
   */
  async noteStep(result: FlowStepResult, live: HydrationSession): Promise<void> {
    const first = 0 === this.#reported;
    this.#reported += 1;
    if (this.#failed !== undefined || (result.ok && result.drift === undefined)) {
      return;
    }
    const wait = this.#onPage;
    this.#failed = {};
    if (wait?.stillPending !== true) {
      return;
    }
    if (first || HydrationRead.PENDING === (await readHydration(live))) {
      this.#failed = { unhydrated: wait };
    }
  }

  /** The most recent wait that reached its bound, for the replay result. */
  get wait(): HydrationWait | undefined {
    return this.#last;
  }

  /** Why the replay is unverifiable, when its first failed step ran on a page not hydrated. */
  unverifiableReason(steps: readonly FlowStepResult[]): string | undefined {
    const wait = this.#failed?.unhydrated;
    const failed = steps.find((step) => !step.ok || step.drift !== undefined);
    return wait === undefined || failed === undefined ? undefined : notHydratedReason(wait, failed);
  }
}

const HYDRATION_WAIT_SHAPE = {
  waitedMs: z.number(),
  budgetMs: z.number(),
  stillPending: z.boolean(),
};

/** `FlowReplayResult.hydrationWait`, declared so a validating profile does not strip it. */
export const HYDRATION_WAIT_OUTPUT = z
  .object(HYDRATION_WAIT_SHAPE)
  .optional()
  .describe(
    'Set when replay stopped waiting for a page that was not hydrated, at budgetMs. A step on that page ran before React attached all of its handlers. stillPending is false when the page did not answer.',
  );

/** `SuiteVerdict.hydrationWaits`, declared so a validating profile does not strip it. */
export const SUITE_HYDRATION_WAITS_OUTPUT = z
  .array(z.object({ flow: z.string(), ...HYDRATION_WAIT_SHAPE }))
  .optional()
  .describe(
    'Flows whose replay stopped waiting for a page that was not hydrated, passed or not. Absent when every page hydrated inside the bound.',
  );
