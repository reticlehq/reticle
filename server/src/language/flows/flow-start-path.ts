/**
 * Replay's arrival at a flow's start page: navigate (or reload) before step 1, wait for the session
 * the SDK reconnects as, and say what happened when it does not.
 */

import {
  EventType,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
  type FlowReplayResult,
  type ReticleEvent,
  type StartPageWait,
} from '@reticlehq/core';
import { establishedState, samePath, startPathBudgetMs } from './flow-journey.js';
import { asRecord } from '@reticlehq/core';
import {
  navigablePath,
  routeOfEvent,
  routeOfUrl,
} from '@reticlehq/engine/question/predicate/predicate-route.js';
import type { ArrivalClock } from '@/surface/tools/act/navigation/navigate-arrival.js';
import { carryReticleIdentity } from '@/surface/tools/lease-tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';
import { anchorPrecondition, anchorQueryArgs } from './flow-step-runners.js';
import { queryRefs } from './replay.js';
import { isDocumentGoneError } from '@/portal/session/facts/session-replaced.js';

/** The slice of a session the start-path logic reads: the live URL plus the event buffer. */
interface StartPathSession {
  url?: string;
  eventsSince(cursor: number): ReticleEvent[];
}

/**
 * The route the tab is on now: the last observed route.change, falling back to the pathname of the
 * session's own URL. The fallback matters — a tab that hard-loaded its page emits no route event
 * (the route observer only sees pushState/replaceState/popstate), but the HELLO url still names
 * where it sits, and without it a wrong-page replay reported plain drift with no hint at all.
 */
function currentPathOf(session: StartPathSession): string | undefined {
  const routes = session.eventsSince(0).filter((e) => e.type === EventType.ROUTE_CHANGE);
  const last = routes.at(-1);
  // pathname + search + hash, because `startPath` is compared against this and must stay NAVIGABLE.
  //
  // Reading the pathname alone made both sides `/` on a hash router — always "same path", so the
  // hint never fired however far the tab had drifted, on the router desktop renderers use by
  // default. Leaving the SEARCH out was the mirror defect: `startPath` keeps its query, so a flow
  // starting at `/admin/events/7?tab=wrap` never matched a tab sitting on exactly that, re-navigated
  // on every replay, and the re-navigation killed the session mid-flow.
  //
  // Comparing without the query instead would have been worse in the direction that matters. The
  // query usually decides what the page renders, so a tab on `?tab=summary` would read as "already
  // at `?tab=wrap`" and the replay would start on the wrong page with nothing saying so. Both sides
  // carry it, which keeps a real difference visible and stops the false one.
  // Reticle's own params dropped, as the recording drops them from `startPath` (#1411).
  const observed = last === undefined ? undefined : routeOfEvent(last);
  if (observed !== undefined) {
    return navigablePath(observed);
  }
  if (session.url === undefined) {
    return undefined;
  }
  const fromUrl = routeOfUrl(session.url);
  return fromUrl === undefined ? undefined : navigablePath(fromUrl);
}

/**
 * When a flow records the page its journey started on (`startPath`) and the tab is currently on a
 * different route, step 1 drifts for a reason that has nothing to do with the app regressing — the
 * anchor simply isn't on this page yet. Detect that so the decision says "navigate there first"
 * instead of a mystifying "a step no longer matches". Returns undefined when the routes agree or the
 * current route is unobservable — never a false alarm. Replay normally never gets here on a
 * wrong page (arriveAtStartPath navigates before step 1); this is the fallback when navigation
 * was refused. A page that never reconnected is reported as unverifiable before step 1.
 */
export function startPathMismatchHint(
  flow: FlowFile,
  session: StartPathSession,
): string | undefined {
  const startPath = flow.startPath;
  if (startPath === undefined || 0 === startPath.length) {
    return undefined;
  }
  const current = currentPathOf(session);
  if (current === undefined || samePath(current, startPath)) {
    return undefined;
  }
  return `this flow's journey starts on ${startPath} but the tab is on ${current} — navigate there (reticle_navigate { url: "${startPath}" }), then replay`;
}

/** How often replay looks for the SDK on the start page; how long is `startPathBudgetMs`. */
const START_PATH_POLL_MS = 100;
/**
 * How long replay keeps waiting past the step budget while the page says it is still loading
 * (#1705). The bound keeps a page that never finishes from holding the replay forever.
 */
const START_PATH_LOADING_CAP_MS = 30_000;

/** A probe that fails counts as loaded, so it can only end the wait, never stretch it. */
async function pageStillLoading(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return true === (await probe());
  } catch {
    return false;
  }
}

const REAL_ARRIVAL_CLOCK: ArrivalClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The session `oldId` denotes right now — itself, or the tombstone successor `resolve` rebinds to
 * after a full-document navigation. A different instance proves the SDK reconnected even when the
 * app redirected to another route. Keyed to the navigated tab's own identity on purpose: matching
 * "any session at the target page" could hand replay an unrelated tab already sitting there.
 */
function arrivedSuccessor(
  sessions: SessionManager,
  oldId: string,
  target: string,
  /** The handle that issued the navigation. */
  issuedBy: object,
  isReload: boolean,
): { session: Session; matches: boolean } | undefined {
  try {
    const candidate = sessions.resolve(oldId);
    // A reload can return the dying handle on the same path. Compare instances, not ids: a leased
    // tab can reconnect under the same id. A redirect counts only on a new instance.
    if (isReload && candidate === issuedBy) {
      return undefined;
    }
    const path = currentPathOf(candidate);
    if (path === undefined) {
      return undefined;
    }
    const matches = samePath(path, target);
    // A still-connected old tab on the wrong route is not a redirected successor.
    return matches || candidate !== issuedBy ? { session: candidate, matches } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Can step 1 start from where the tab already is?
 *
 * A route mismatch is NOT on its own a reason to navigate. The condition worth a page load is that
 * the first anchor is not reachable from here — and a flow whose first anchor lives somewhere
 * persistent (a sidebar, a header, a nav rail) is reachable from every route.
 *
 * Navigating anyway is expensive in the one direction that matters: a full page load tears the
 * session down and brings the app back COLD, which for a flow recorded after signing in is the
 * login screen. Step 1 then reports its anchor missing and blames a file that is completely fine.
 * A best-effort step that can leave the caller WORSE off than skipping it is not best-effort.
 *
 * Unresolvable either way (no anchor we can query, a failed query) reads as "cannot tell", and the
 * navigation goes ahead — the pre-existing behaviour, and the safe direction for a check whose whole
 * job is to avoid making things worse.
 */
async function firstStepResolvesHere(
  session: { command(name: string, args?: Record<string, unknown>): Promise<CommandResult> },
  flow: FlowFile,
): Promise<boolean> {
  const first = flow.steps?.[0];
  if (first === undefined) {
    return false;
  }
  const args = anchorQueryArgs(first.anchor);
  if (null === args) {
    return false;
  }
  try {
    return 0 < queryRefs(await session.command(ReticleCommand.QUERY, args)).length;
  } catch {
    return false;
  }
}

/** What replay learned on its way to step 0. Both fields absent = the tab was left exactly as it was. */
export interface StartPathArrival {
  /** The successor session replay must continue on. Absent when nothing was navigated, or arrival timed out. */
  session?: Session;
  /** Set when the RESET itself is why step 1 cannot start — the reason a step-1 red is not drift. */
  resetCost?: string;
  /** Set when the tab was sent away and nothing reconnected: the old handle will never answer (#1129). */
  lost?: string;
  /** A live successor arrived on a different route, so replay must not use the dead old handle. */
  redirected?: string;
  /** Set when the page's loading kept replay waiting past the step budget. */
  wait?: StartPageWait;
}

/** The replay result, with how long replay waited for its start page when that went past the budget. */
export function withStartPageWait<R extends FlowReplayResult>(
  result: R,
  arrival: StartPathArrival,
): R {
  return arrival.wait === undefined ? result : { ...result, startPageWait: arrival.wait };
}

/** The `wait` an outcome carries, ready to spread into an arrival. */
function waitOf(outcome: { wait?: StartPageWait }): { wait?: StartPageWait } {
  return outcome.wait === undefined ? {} : { wait: outcome.wait };
}

/**
 * Replay's half of the FlowFile contract: put the tab on the flow's `startPath` before step 1, and
 * RELOAD it if it is already there.
 *
 * The reload is the state contract. Replaying "add a task" twice against a tab nobody reset gives
 * the second run a world the recording never saw, and its assertions then describe the first run
 * rather than the app. Our own `replay-determinism.mjs` has always refreshed before every run — the
 * determinism we measured was never the determinism a user got.
 *
 * `requires` is the declared opt-out, and its first caller. A flow that says it starts from state
 * another flow established is the one flow a page load would destroy, so it is never reset — here
 * or from the wrong page. Silence is not an opt-out: a flow that depends on leftovers without
 * saying so is a flow whose green means nothing on a fresh machine, and CI is a fresh machine.
 *
 * A full-page load tears down the session socket, so the navigation must happen here — before any
 * step runs — and the replay continues on the session the SDK reconnects as (found via the same
 * tombstone rebind that lets `resolve(oldId)` answer after any navigation). Best-effort by design:
 * when the flow carries no startPath, the current route is unobservable, or navigation is refused,
 * replay proceeds on the connected session. A missing successor stops before step 1; a redirect
 * continues on the live successor with a route-specific hint.
 */
export async function arriveAtStartPath(
  sessions: SessionManager,
  session: StartPathSession & {
    id: string;
    command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  },
  flow: FlowFile,
  timeoutMs: number = startPathBudgetMs(flow),
  clock: ArrivalClock = REAL_ARRIVAL_CLOCK,
  /** Whether the tab is still loading. Replay passes one for a pool lease, the only tab it can ask. */
  stillLoading?: () => Promise<boolean>,
  loadingCapMs: number = START_PATH_LOADING_CAP_MS,
): Promise<StartPathArrival> {
  const target = flow.startPath;
  if (target === undefined || 0 === target.length) {
    return {};
  }
  const current = currentPathOf(session);
  if (current === undefined) {
    return {};
  }
  // The declared opt-out, both directions. See above.
  if (0 < establishedState(flow).length) {
    return {};
  }
  const here = samePath(current, target);
  // A route mismatch that step 1 can start from anyway is not worth a page load: navigating away
  // from a persistent anchor could only hurt, and did. Arriving is the goal; resetting a tab that is
  // ALREADY here is a different decision, taken above, and this must not override it.
  if (!here && (await firstStepResolvesHere(session, flow))) {
    return {};
  }
  let destination: string;
  try {
    // startPath is a pathname (a host belongs to the machine, not the journey) — resolve it
    // against the tab's own URL to get something the browser can be sent to. Already HERE, the
    // reset reloads the page the tab is on: `samePath` ignored a query the flow did not record, and
    // navigating to `target` would strip it, so the replay would test a different page than the one
    // it just agreed it was on.
    destination = new URL(here ? current : target, session.url).toString();
  } catch {
    return {}; // no usable base URL — nowhere to navigate from
  }
  // Measured either side of the reset, and only when the reset is a reload: reachable before and
  // gone after is the reload's doing, not the flow file's. Without this, an app holding its session
  // in memory comes back signed out and step 1 blames a component that is completely fine.
  const resolvedBefore = here && (await firstStepResolvesHere(session, flow));
  const outcome = await navigateAndAwait(
    sessions,
    session,
    destination,
    target,
    timeoutMs,
    clock,
    here,
    stillLoading,
    loadingCapMs,
  );
  if ('lost' === outcome.kind) {
    const why = outcome.stillLoading
      ? 'The page was still loading when replay stopped waiting: check that the app finishes loading, then replay'
      : 'A slow or backgrounded tab can take longer to come back: bring it to the front and replay';
    return {
      lost:
        `replay ${here ? 'reloaded' : 'navigated to'} ${target} before step 1 and no page was connected ` +
        `after ${String(outcome.waitedMs)}ms, so the session it was driving is gone and nothing ran. ${why}`,
      ...waitOf(outcome),
    };
  }
  if ('refused' === outcome.kind) {
    return {};
  }
  if ('redirected' === outcome.kind) {
    const path = currentPathOf(outcome.session) ?? 'another route';
    return {
      session: outcome.session,
      redirected: `replay ${here ? 'reloaded' : 'navigated to'} ${target} before step 1, but the tab reconnected on ${path}. Check the redirect or sign in before replaying`,
      ...waitOf(outcome),
    };
  }
  const arrived = outcome.session;
  if (!resolvedBefore || (await firstStepResolvesHere(arrived, flow))) {
    return { session: arrived, ...waitOf(outcome) };
  }
  return {
    session: arrived,
    resetCost: resetCostHint(flow, target),
    ...waitOf(outcome),
  };
}

/**
 * Why step 1 failed after the reset, and the one line that opts the flow out.
 *
 * No tool writes `requires`, so naming the field was advice nobody could act on without guessing its
 * shape. The first anchor IS the precondition: the element step 1 needs, present before it runs.
 */
function resetCostHint(flow: FlowFile, target: string): string {
  const first = flow.steps?.[0];
  const needs = first === undefined ? undefined : anchorPrecondition(first.anchor);
  const optOut =
    needs === undefined
      ? 'Declare what it needs (`requires`) in the flow file to opt out of the reset'
      : `Add \`"requires":${JSON.stringify([needs])}\` to the flow file to opt out of the reset`;
  return (
    `replay reloaded ${target} before step 1 and the first anchor did not come back — this flow ` +
    `starts from state a page load discards. ${optOut}, or record it from a cold page`
  );
}

/**
 * Send a tab somewhere and wait for the session that comes back.
 *
 * A navigation is a full page load: the session that issued it DIES and a successor connects with a
 * new id. Every caller therefore has to wait for that successor rather than reuse the handle it
 * already holds, and getting this wrong does not error — it leaves the caller talking to a session
 * that will never answer again.
 *
 * Extracted so there is ONE of these rather than one per caller. `arriveAtStartPath` decides WHETHER
 * to move and this decides how, which is also why the deliberate short-circuits live up there and
 * not in here: a caller that has already decided it must move should not have to argue with them.
 */
/**
 * How a navigate ended: target, redirect, refusal (untouched tab), or no successor. `wait` is set
 * when the page's loading earned it time past the budget.
 */
export type NavigateOutcome =
  | { kind: 'arrived'; session: Session; wait?: StartPageWait }
  | { kind: 'redirected'; session: Session; wait?: StartPageWait }
  | { kind: 'refused' }
  | { kind: 'lost'; waitedMs: number; stillLoading: boolean; wait?: StartPageWait };

export async function navigateAndAwait(
  sessions: SessionManager,
  session: {
    id: string;
    /** Optional because a session's URL is, and `carryReticleIdentity` already handles its absence. */
    url?: string;
    command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  },
  destination: string,
  expectedPath: string,
  timeoutMs: number,
  clock: ArrivalClock = REAL_ARRIVAL_CLOCK,
  /** True when the destination is the page we are already on — see `arrivedSuccessor`. */
  isReload: boolean = false,
  /** Whether the navigated page is still loading; absent when it cannot be asked. */
  stillLoading?: () => Promise<boolean>,
  loadingCapMs: number = START_PATH_LOADING_CAP_MS,
): Promise<NavigateOutcome> {
  // A leased tab is addressed by URL params, so navigating without them would strand the lease.
  const url = carryReticleIdentity(session.url, destination);
  try {
    const outcome = await session.command(ReticleCommand.NAVIGATE, { url });
    if (!outcome.ok || true !== asRecord(outcome.result)['ok']) {
      return { kind: 'refused' };
    }
  } catch (error: unknown) {
    // A navigation that unloads the page rejects the very command that asked for it — the transport
    // dies with the document. Reading that as "the navigate failed" skipped the arrival poll below
    // and left replay driving a handle that could never answer again, which is how a flow with a
    // startPath died at step 1 on an app that had loaded perfectly. Anything else is a real refusal.
    if (!isDocumentGoneError(error)) {
      return { kind: 'refused' };
    }
  }
  const start = clock.now();
  const deadline = start + timeoutMs;
  const cap = start + Math.max(timeoutMs, loadingCapMs);
  let loading = false;
  let extended = false;
  const extendedWait = (): { wait?: StartPageWait } =>
    extended
      ? { wait: { waitedMs: clock.now() - start, budgetMs: timeoutMs, stillLoading: loading } }
      : {};
  for (;;) {
    const arrived = arrivedSuccessor(sessions, session.id, expectedPath, session, isReload);
    if (true === arrived?.matches) {
      return { kind: 'arrived', session: arrived.session, ...extendedWait() };
    }
    if (clock.now() >= deadline) {
      // A live redirect is a different result from no SDK reconnection at all.
      if (arrived !== undefined) {
        return { kind: 'redirected', session: arrived.session, ...extendedWait() };
      }
      // Past the budget, only a page that says it is still loading earns more time (#1705).
      loading = stillLoading !== undefined && (await pageStillLoading(stillLoading));
      extended ||= loading;
      if (!loading || clock.now() >= cap) {
        return {
          kind: 'lost',
          waitedMs: clock.now() - start,
          stillLoading: loading,
          ...extendedWait(),
        };
      }
    }
    await clock.sleep(START_PATH_POLL_MS);
  }
}
