import { resolveFlowUploads } from './fields/flow-upload-resolve.js';
import { learnFromRun } from '@reticlehq/engine/evidence/learned-guards.js';
import {
  type ProjectId,
  EventType,
  FLOW_SIGNAL_TIMEOUT_MS,
  FlowErrorCode,
  RecordedFlowSchema,
  ReplayStatus,
  ReticleCommand,
  RunKind,
  RunStatus,
  type CommandResult,
  type FlowFile,
  type FlowReplayResult,
  type Contradiction,
  type FlowStepResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { haltedFrom } from './recording/replay-halt.js';
import { asRecord, asString } from '@reticlehq/core';
import { routeOfEvent, routeOfUrl } from '@reticlehq/engine/question/predicate/predicate-route.js';
import type { ArrivalClock } from '@/surface/tools/act/navigation/navigate-arrival.js';
import { carryReticleIdentity } from '@/surface/tools/lease-tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';
import { replayFlow } from './flow-replay.js';
import { anchorPrecondition, anchorQueryArgs } from './flow-step-runners.js';
import { queryRefs } from './replay.js';
import { assertSuccess, dynamicTestids, successLabel, SUCCESS_STEP_TOOL } from './flow-success.js';
import { buildDecision, unverifiableReason } from './decision.js';
import { unsuppliedSecrets } from './fields/flow-secret-field.js';
import {
  assertStepExpect,
  DocumentLostDuringReplay,
  type FlowReplaySession,
} from './flow-replay.js';
import { isDocumentGoneError } from '@/portal/session/facts/session-replaced.js';
import { classifyFlowAssertions, flattenSteps } from './flow-classify.js';
import { dischargeFlowIntent, flowIntentStatement, flowReplayVerdictId } from './flow-intent.js';
import { IntentStore } from '@/memory/intent/intent-store.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { computeSegments } from '@/memory/journal/rollups.js';
import { stepEffect } from '@reticlehq/engine/evidence/step-effect.js';
import { AssertionTiersStore } from './stores/assertion-tiers-store.js';
import { toFlowSources } from './change/flow-sources.js';
import { reportAndAccumulate } from '@/memory/journal/deviation-service.js';
import { EnvelopeStore } from '@/memory/journal/envelope-store.js';
import type { DeviationReport } from '@/memory/journal/deviation-report.js';
import { homedir } from 'node:os';
import { cloudFetch, syncRunRecordToCloud, SyncOutcome } from '@/memory/cloud/cloud-sync.js';
import { resolveProjectCloud } from '@/memory/cloud/cloud-config.js';
import { consultSubjectFor, selectConsulted, type ConsultedMemory } from './flow-memory-consult.js';
import { log } from '@/log.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { flowsForSession } from './flow-store-for-session.js';
import { projectForRoot } from '@/memory/project/project-for-root.js';
import { FlowParseNote } from './flow-expect-grammar.js';

export function latestRecordedFlow(
  events: ReticleEvent[],
): { name: string; flow: import('@reticlehq/core').FlowFile } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== EventType.FLOW_RECORDED) continue;
    const parsed = RecordedFlowSchema.safeParse(event.data);
    if (parsed.success) return { name: parsed.data.name, flow: parsed.data.flow };
  }
  return undefined;
}

/** Map a structured FlowErrorCode to a legible one-line message for the agent. */
export function flowErrorMessage(code: FlowErrorCode, detail?: string): string {
  if (FlowErrorCode.PARSE_FAILED === code && undefined !== detail) return detail;
  // The detail names both versions and the remedy, so it beats anything generic this could say.
  if (FlowErrorCode.WRONG_VERSION === code && undefined !== detail) return detail;
  switch (code) {
    case FlowErrorCode.INVALID_NAME:
      return 'invalid flow name — use a single safe segment (letters/digits/-/_), no path separators';
    case FlowErrorCode.NOT_FOUND:
      return 'no such flow on disk — run reticle_flow{action:"list"} to see saved flows';
    case FlowErrorCode.PARSE_FAILED:
      return FlowParseNote.MALFORMED;
    case FlowErrorCode.NO_RECORDING:
      return 'no compiled recording by that name — record one (reticle_record{action:"start"|"stop"}) first';
    // Never "regenerate it": the file is intact and the reader is the wrong one. Telling somebody
    // to rewrite an undamaged flow is the failure this code was split out of PARSE_FAILED to stop.
    case FlowErrorCode.WRONG_VERSION:
      return 'this flow file was written in a different flow-file format — the file is not damaged, this Reticle cannot read that version. Upgrade or downgrade Reticle rather than editing the flow';
  }
}

/** Map the wire ReplayStatus onto the persisted RunStatus (ok→pass). */
function replayToRunStatus(status: ReplayStatus): RunStatus {
  switch (status) {
    case ReplayStatus.OK:
      return RunStatus.PASS;
    case ReplayStatus.DRIFT:
      return RunStatus.DRIFT;
    case ReplayStatus.ERROR:
      return RunStatus.ERROR;
  }
}

/**
 * Append a flow-replay outcome to .reticle/project.json (never throws into replay) and, when logged in,
 * best-effort mirror it to Reticle so the team's server-side regression history stays current. The
 * cloud push is fire-and-forget: not logged in → skipped, a network failure is logged and swallowed.
 */
async function recordReplayRun(
  deps: ToolDeps,
  name: string,
  status: ReplayStatus,
  driftSteps: number,
  durationMs: number,
  projectId: ProjectId | undefined,
  /** The APP's `.reticle`, resolved from the session — never the daemon's own. */
  recordRoot: string,
): Promise<void> {
  const runStatus = replayToRunStatus(status);
  await projectForRoot(deps, recordRoot).recordRun({
    kind: RunKind.FLOW_REPLAY,
    name,
    status: runStatus,
    evidence: { driftSteps },
    durationMs,
  });
  // Per-project cloud: push memory outcomes only when cloud is attached AND memory sync is enabled.
  // Rooted at the APP, not the daemon — see consultProjectMemory. This call had the same defect and
  // it was worse here: a replay outcome that should have reached the dashboard silently did not,
  // because the daemon's own directory has no link file.
  const cloud = await resolveProjectCloud(deps.fs, recordRoot, homedir(), process.env);
  if (null === cloud.config || !cloud.policy.memory) return; // not attached / memory disabled → local only
  const result = await syncRunRecordToCloud(
    { kind: RunKind.FLOW_REPLAY, name, status: runStatus, at: deps.now(), durationMs },
    projectId,
    cloud.config,
    cloudFetch,
  );
  if (result.outcome !== SyncOutcome.SYNCED) {
    log('cloud-run-record-sync-failed', { flow: name, status: result.status, error: result.error });
  }
}

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
  const observed = last === undefined ? undefined : routeOfEvent(last);
  if (observed !== undefined) return `${observed.docPath}${observed.search}${observed.hash}`;
  if (session.url === undefined) return undefined;
  const fromUrl = routeOfUrl(session.url);
  return fromUrl === undefined ? undefined : `${fromUrl.docPath}${fromUrl.search}${fromUrl.hash}`;
}

/**
 * Is the tab where the flow asked to start? Up to a trailing slash, and up to the query the flow
 * did not ask about.
 *
 * `startPath` is the SPECIFICATION, so it decides what counts. A query it recorded is compared:
 * `?tab=wrap` and `?tab=summary` are different pages, and a replay that starts on the wrong one
 * proves nothing about the right one. A query it did NOT record is ignored: the tab carrying
 * `?next=%2F` on a login page, or the identity params Reticle puts on a leased tab, are not the flow
 * being elsewhere, and navigating to strip them costs a session for nothing.
 *
 * The asymmetry is the whole point and the reason `observed` and `expected` are named rather than
 * `a` and `b`. Comparing with the query on both sides always re-navigated a query-bearing
 * `startPath` (#1059, which killed the session mid-flow); comparing with it on neither side reads a
 * tab on `?tab=summary` as already at `?tab=wrap`.
 */
function samePath(observed: string, expected: string): boolean {
  const trimmed = (path: string): string => path.replace(/\/$/, '');
  const withoutQuery = (path: string): string => path.replace(/\?[^#]*/, '');
  const comparable = expected.includes('?') ? observed : withoutQuery(observed);
  return trimmed(comparable) === trimmed(expected);
}

/**
 * Ask the project what it already knows about this flow.
 *
 * Best-effort in the strongest sense: an unlinked project, a disabled memory policy, an offline
 * laptop and a server that answers nonsense all reach the same place — the verdict returns without
 * a memory block. A verification that FAILED because the knowledge lookup failed would be a worse
 * product than one that never looked, and this is the path every replay takes.
 *
 * The read is also what makes the coverage map's fetch counts mean anything: they were zero across
 * the entire corpus, not because memory is useless but because consulting it was a separate act
 * nobody performed. Now the platform performs it.
 */
async function consultProjectMemory(
  deps: ToolDeps,
  flow: FlowFile,
  root: string,
): Promise<ConsultedMemory[] | undefined> {
  const subject = consultSubjectFor(flow);
  if (subject === undefined) return undefined;
  try {
    // The APP's root, not the daemon's. `deps.reticleRoot` is wherever the daemon was launched,
    // which for a user-scoped MCP registration is almost never the project being verified — so the
    // link file it reads is the wrong one, or absent, and every project silently reads as
    // "not attached". Same class of bug as the flow store resolving per daemon instead of per
    // session, and it is invisible: the feature simply never appears.
    const cloud = await resolveProjectCloud(deps.fs, root, homedir(), process.env);
    if (null === cloud.config || !cloud.policy.memory) return undefined;
    const url = `${cloud.config.url}/v1/memory?subject=${encodeURIComponent(subject)}`;
    const res = await cloudFetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${cloud.config.apiKey}` },
    });
    if (200 !== res.status) return undefined;
    // `cloudFetch` hands back a real `Response`, so the body is a METHOD. Reading `res.json` as a
    // property yields the function itself, `.entries` on it is undefined, and the whole feature
    // fails silently to "the project knows nothing" — which is indistinguishable from the honest
    // empty case and is why this took a live drive to notice at all.
    const body = (await res.json()) as { entries?: unknown } | undefined;
    const entries = body?.entries;
    if (!Array.isArray(entries)) return undefined;
    const picked = selectConsulted(entries as { statement?: unknown; status?: unknown }[]);
    return 0 === picked.length ? undefined : picked;
  } catch {
    // See the note above: never the reason a verdict fails to return.
    return undefined;
  }
}

/**
 * When a flow records the page its journey started on (`startPath`) and the tab is currently on a
 * different route, step 1 drifts for a reason that has nothing to do with the app regressing — the
 * anchor simply isn't on this page yet. Detect that so the decision says "navigate there first"
 * instead of a mystifying "a step no longer matches". Returns undefined when the routes agree or the
 * current route is unobservable — never a false alarm. Replay normally never gets here on a
 * wrong page (arriveAtStartPath navigates before step 1); this is the fallback for when that
 * navigation was refused or the SDK never reconnected in the window.
 */
export function startPathMismatchHint(
  flow: FlowFile,
  session: StartPathSession,
): string | undefined {
  const startPath = flow.startPath;
  if (startPath === undefined || 0 === startPath.length) return undefined;
  const current = currentPathOf(session);
  if (current === undefined || samePath(current, startPath)) return undefined;
  return `this flow's journey starts on ${startPath} but the tab is on ${current} — navigate there (reticle_navigate { url: "${startPath}" }), then replay`;
}

/** How long replay waits for the SDK to reconnect on the start page before falling back to the hint. */
const START_PATH_ARRIVAL_TIMEOUT_MS = 5_000;
const START_PATH_POLL_MS = 100;

const REAL_ARRIVAL_CLOCK: ArrivalClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The session `oldId` denotes right now — itself, or the tombstone successor `resolve` rebinds to
 * after a full-document navigation — but only once it actually sits on `target`. Undefined while
 * the tab is still travelling (or in the gap between teardown and the successor's HELLO, when
 * `resolve` throws). Keyed to the navigated tab's own identity on purpose: matching "any session at
 * the target page" would happily hand replay an unrelated tab that was already sitting there.
 */
function arrivedSuccessor(
  sessions: SessionManager,
  oldId: string,
  target: string,
  /** The handle that issued the navigation, when only a genuinely new one counts as arrival. */
  mustReplace: object | undefined,
): Session | undefined {
  try {
    const candidate = sessions.resolve(oldId);
    /*
     * A RELOAD lands on the path it left, so the path cannot tell the successor from the tab that
     * is still tearing down — `resolve(oldId)` answers with the dying one while it is registered,
     * which looks like instant arrival and hands replay a socket that will never answer again.
     *
     * The discriminator is the OBJECT, not the id. A leased tab carries its identity across a page
     * load (that is what the identity params are for), so it reconnects under the SAME id — waiting
     * for a new id there waits forever, and the first lease this was tried on timed out at step 1
     * on a tab that was perfectly healthy. `SessionManager.add` replaces the instance on every
     * reconnect, so a different instance is exactly "the socket came back".
     *
     * A navigation to a different route has the path as its discriminator and does not need this.
     */
    if (mustReplace !== undefined && candidate === mustReplace) return undefined;
    const path = currentPathOf(candidate);
    return path !== undefined && samePath(path, target) ? candidate : undefined;
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
  if (first === undefined) return false;
  const args = anchorQueryArgs(first.anchor);
  if (null === args) return false;
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
 * when the flow carries no startPath, the current route is unobservable, the navigation is refused,
 * or the SDK never reconnects in the window, replay proceeds on the connected session as before —
 * with startPathMismatchHint turning any resulting drift into an actionable next move rather than a
 * mystifying one.
 */
export async function arriveAtStartPath(
  sessions: SessionManager,
  session: StartPathSession & {
    id: string;
    command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  },
  flow: FlowFile,
  timeoutMs: number = START_PATH_ARRIVAL_TIMEOUT_MS,
  clock: ArrivalClock = REAL_ARRIVAL_CLOCK,
): Promise<StartPathArrival> {
  const target = flow.startPath;
  if (target === undefined || 0 === target.length) return {};
  const current = currentPathOf(session);
  if (current === undefined) return {};
  // The declared opt-out, both directions. See above.
  if (0 < (flow.requires?.length ?? 0)) return {};
  const here = samePath(current, target);
  // A route mismatch that step 1 can start from anyway is not worth a page load: navigating away
  // from a persistent anchor could only hurt, and did. Arriving is the goal; resetting a tab that is
  // ALREADY here is a different decision, taken above, and this must not override it.
  if (!here && (await firstStepResolvesHere(session, flow))) return {};
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
  const arrived = await navigateAndAwait(
    sessions,
    session,
    destination,
    target,
    timeoutMs,
    clock,
    here,
  );
  if (arrived === undefined) return {};
  if (!resolvedBefore || (await firstStepResolvesHere(arrived, flow))) return { session: arrived };
  return {
    session: arrived,
    resetCost: resetCostHint(flow, target),
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
  timeoutMs: number = START_PATH_ARRIVAL_TIMEOUT_MS,
  clock: ArrivalClock = REAL_ARRIVAL_CLOCK,
  /** True when the destination is the page we are already on — see `arrivedSuccessor`. */
  isReload: boolean = false,
): Promise<Session | undefined> {
  // A leased tab is addressed by URL params, so navigating without them would strand the lease.
  const url = carryReticleIdentity(session.url, destination);
  try {
    const outcome = await session.command(ReticleCommand.NAVIGATE, { url });
    if (!outcome.ok || true !== asRecord(outcome.result)['ok']) return undefined;
  } catch (error: unknown) {
    // A navigation that unloads the page rejects the very command that asked for it — the transport
    // dies with the document. Reading that as "the navigate failed" skipped the arrival poll below
    // and left replay driving a handle that could never answer again, which is how a flow with a
    // startPath died at step 1 on an app that had loaded perfectly. Anything else is a real refusal.
    if (!isDocumentGoneError(error)) return undefined;
  }
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const arrived = arrivedSuccessor(
      sessions,
      session.id,
      expectedPath,
      isReload ? session : undefined,
    );
    if (arrived !== undefined) return arrived;
    if (clock.now() >= deadline) return undefined;
    await clock.sleep(START_PATH_POLL_MS);
  }
}

/**
 * Replay one named flow end to end: load → re-resolve+run each step → assert the success oracle →
 * status + decision. Shared by reticle_flow_replay (single flow) and reticle_flow_verify (whole suite) so
 * both produce identical FlowReplayResults. Every exit path records a run to project.json.
 */

/**
 * Every flow reachable from this one by `invoke`, loaded once for the whole replay.
 *
 * Breadth-first with a `seen` set so a cycle terminates rather than trusting that typecheck ran.
 * A sub-flow that will not load is simply absent, and the grader then declines to credit it — the
 * conservative direction, because a composite graded on a flow nobody could read is graded on a
 * promise.
 */
async function loadInvokedFlows(
  deps: ToolDeps,
  flow: FlowFile,
  projectId?: ProjectId,
): Promise<Map<string, FlowFile>> {
  const out = new Map<string, FlowFile>();
  const queue: FlowFile[] = [flow];
  const seen = new Set<string>([flow.name]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const step of flattenSteps(current.steps)) {
      const name = step.invoke;
      if (name === undefined || seen.has(name)) continue;
      seen.add(name);
      const sub = await flowsForSession(deps, projectId).flows.load(name, projectId);
      if (!sub.ok) continue;
      out.set(name, sub.value);
      queue.push(sub.value);
    }
  }
  return out;
}

/**
 * The first precondition this flow declares that does not hold, described for a reader.
 *
 * Undefined means every declared claim held, OR that the flow declared none — and those two are the
 * same answer on purpose. Silence is permissive: every flow recorded before `requires` existed
 * declares nothing, and treating "did not say" as "not satisfied" would make every one of them
 * unverifiable on the day this shipped.
 *
 * Only the FIRST is reported. A reader fixes preconditions one at a time, and the second is usually
 * a consequence of the first being absent.
 */
async function firstUnmetPrecondition(
  session: FlowReplaySession,
  flow: FlowFile,
  since: number,
): Promise<string | undefined> {
  for (const claim of flow.requires ?? []) {
    // Zero budget: a precondition is a claim about the state you are starting FROM. Waiting for one
    // turns "was it true" into "did it become true", which is a different and much weaker question.
    let drift: Awaited<ReturnType<typeof assertStepExpect>>;
    try {
      drift = await assertStepExpect(session, claim, waitForPredicate, 0, since);
    } catch (error: unknown) {
      if (!isDocumentGoneError(error)) throw error;
      return `the page went away while this flow's preconditions were being checked, so nothing ran and nothing was proved. Replay again once the page is back.`;
    }
    if (drift !== undefined) {
      return `a precondition of this flow does not hold (${JSON.stringify(claim)}), so nothing ran and nothing was proved. Run the flow that establishes it first, or drive that state yourself.`;
    }
  }
  return undefined;
}

/**
 * The honest answer when the document replay was driving went away mid-run.
 *
 * Not a pass: nothing graded the journey, and the steps in hand are only the ones the departed
 * document answered. Not a failure either — the app was never observed doing anything wrong, and
 * reporting one would be the false red that sends a reader into product code that is fine. So it
 * lands in the bucket this engine already has for "nothing was proved", the same one an unmet
 * precondition uses, with the steps that DID answer attached and no row invented for the one that
 * did not.
 *
 * Why replay reports rather than follows: the successor cannot be identified at the moment the
 * socket closes. `SessionManager.remove` runs from the close handler, writes the tombstone a
 * successor is later matched against, and has nothing to match yet — so the rejection is a plain
 * transport failure by design, and a step in the middle of a journey has no budget to sit and poll
 * with. `navigateAndAwait` CAN wait, because it knows it asked for the navigation, and it does.
 */
export function lostDocumentResult(name: string, lost: DocumentLostDuringReplay): FlowReplayResult {
  return {
    name,
    status: ReplayStatus.OK,
    steps: lost.steps,
    unverifiable: {
      reason:
        `the page's connection to Reticle was replaced while step ${String(lost.atStep)} was running ` +
        `(a new document loaded, or its socket reconnected), so the run ` +
        `could not be graded — the steps before it are reported and nothing after it was observed. ` +
        `Nothing here says the app failed. If that navigation is part of the journey, record the ` +
        `step's consequence with \`expect\` and replay again; if it was not, the flow started ` +
        `somewhere it no longer belongs.`,
    },
  };
}

export async function replayNamedFlow(
  deps: ToolDeps,
  args: Record<string, unknown>,
  /** Wraps the session the steps run on, so a caller can watch what they resolved. */
  observe: (session: FlowReplaySession) => FlowReplaySession = (s) => s,
): Promise<FlowReplayResult> {
  const startedAt = deps.now();
  const name = asString(args['flowName']) ?? '';
  // Resolve within the connecting app's scope so a shared daemon replays THIS project's flow, not a
  // same-named flow from another app. Safe-resolve: a missing session degrades to the global store,
  // and the load-then-session order (unchanged) still surfaces a not-found before a no-session error.
  let projectId: ProjectId | undefined;
  try {
    projectId = deps.sessions.resolve(asString(args['sessionId'])).projectId;
  } catch {
    projectId = undefined;
  }
  // The app's store, not the daemon's: this load answering `flow_not_found` for a flow plainly on
  // disk is what made replay unusable from a daemon started outside the project.
  const loaded = await flowsForSession(deps, projectId).flows.load(name, projectId);
  if (!loaded.ok) {
    await recordReplayRun(
      deps,
      name,
      ReplayStatus.ERROR,
      0,
      deps.now() - startedAt,
      projectId,
      sessionRoot(deps, asString(args['sessionId'])),
    );
    return {
      name,
      status: ReplayStatus.ERROR,
      steps: [],
      error: { code: loaded.code, message: flowErrorMessage(loaded.code, loaded.detail) },
    };
  }
  // What this flow is FOR, from the shared ledger — so a failure can report the business outcome
  // that stopped being true before the step that stopped being green. Undefined when nothing
  // declared one, which the decision then says plainly rather than inventing a goal from step names.
  /*
   * The APP's `.reticle`, resolved once. Everything below that reaches the project's own files —
   * the intent ledger, the cloud link, the memory consultation — takes THIS, not `deps.reticleRoot`,
   * which is wherever the daemon happened to be launched.
   */
  const replayRoot = sessionRoot(deps, asString(args['sessionId']));
  const intents = new IntentStore(deps.fs, replayRoot, { now: deps.now });
  const intentSaid = await flowIntentStatement(intents, loaded.value);
  const connected = deps.sessions.resolve(asString(args['sessionId']));
  // The FlowFile contract: replay navigates to the flow's startPath before step 1, and the steps run
  // on the session the SDK reconnects as. When arrival can't be confirmed, replay proceeds on the
  // connected session — and the hint below turns the wrong-page drift into an actionable next move.
  const arrival = await arriveAtStartPath(deps.sessions, connected, loaded.value);
  const session = arrival.session ?? connected;
  // The reset's own cost outranks the wrong-page hint: if the reload is why step 1 cannot start,
  // "navigate there and replay" is advice that would do the same thing again.
  const startPathHint = arrival.resetCost ?? startPathMismatchHint(loaded.value, session);
  // Floor the success oracle at the start of THIS replay so a stale signal from a prior run
  // in the same session can't fake a pass.
  const replayFloor = session.elapsed();
  // A recorded upload names a path on disk; the browser can only take bytes. Resolved once, before
  // step 1, through the same helper the live `reticle_act` uses. See resolveFlowUploads.
  const replayable = await resolveFlowUploads(deps, loaded.value);
  // Loaded once and used for BOTH the replay and the grading below. A composite asserts through
  // what it runs, and a grader that cannot see the sub-flows reports `unverifiable` on a journey
  // that checks itself thoroughly — right about the file, wrong about the journey.
  const invokedFlows = await loadInvokedFlows(deps, replayable, projectId);
  /*
   * The flow's own preconditions, before a single step runs.
   *
   * A flow states what must already be true for it to mean anything. Replaying one whose `requires`
   * does not hold is not a test of the app: it drives a journey from a state it was never recorded
   * in, and whatever happens next is noise. Until this existed that noise arrived as a FAILURE, and
   * a red that is really a missing precondition is the most expensive kind — it sends a reader into
   * product code that is fine.
   *
   * So an unmet precondition is `unverifiable`, never a failure: nothing ran, so nothing was proved.
   * That is the same honesty rule an uncovered change already follows, and `unverifiable` is already
   * the bucket the suite counts apart from both passes and failures.
   *
   * Judged with the SAME function that judges a step's `expect`, because they are the same shape and
   * two judges drift. Evaluated against the replay floor with no waiting: a precondition is a claim
   * about the state you are starting from, and a claim you have to wait for was not true when you
   * asked.
   */
  /*
   * A credential nobody supplied is not a regression, and must not be reported as one.
   *
   * This sits beside the precondition gate because it is the same mistake in a different coat: the
   * flow cannot run from the state it was recorded in, so whatever happens next says nothing about
   * the app. Replay used to type the literal `<redacted: supply at replay>` into the password box
   * and report the missing dashboard further down as `drift`, pointing at a component nobody had
   * touched. MEASURED on the bench app: supplying one variable moved the suite from 4/30 to 13/34.
   *
   * Checked before the preconditions, because a flow that signs in cannot satisfy anything it
   * requires until it can sign in, and the first reason is the one worth reporting.
   */
  const missing = unsuppliedSecrets(replayable, process.env);
  if (missing.length > 0) {
    const names = missing.map((each) => each.envKey).join(', ');
    return {
      name: replayable.name,
      status: ReplayStatus.OK,
      steps: [],
      unverifiable: {
        reason:
          `this flow fills a redacted field and nothing supplied it, so nothing ran and nothing ` +
          `was proved. Set ${names} in the environment the daemon runs in, then replay. Until then ` +
          `the value typed would be the placeholder itself, and any failure after it would be ` +
          `about this and not about the application.`,
      },
    };
  }
  const unmet = await firstUnmetPrecondition(session, replayable, replayFloor);
  if (unmet !== undefined) {
    return {
      name: replayable.name,
      status: ReplayStatus.OK,
      steps: [],
      unverifiable: { reason: unmet },
    };
  }
  let steps: FlowStepResult[];
  try {
    steps = await replayFlow(
      observe(session),
      replayable,
      waitForPredicate,
      FLOW_SIGNAL_TIMEOUT_MS,
      true === args['confirmDangerous'],
      undefined,
      {
        // How an `invoke` step finds the flow it runs. Scoped to the same project as the flow being
        // replayed, so a composite cannot reach into another app's store for a same-named sub-journey.
        resolveFlow: async (invoked: string) => {
          const sub = await flowsForSession(deps, projectId).flows.load(invoked, projectId);
          return sub.ok ? await resolveFlowUploads(deps, sub.value) : undefined;
        },
        // Bug-sweep mode: keep going past a step whose action ran and whose consequence merely did
        // not hold, so one flow reports one verdict per step instead of stopping at the first defect.
        sweep: true === args['sweep'],
      },
    );
  } catch (error: unknown) {
    if (!(error instanceof DocumentLostDuringReplay)) throw error;
    return lostDocumentResult(name, error);
  }
  // Computed HERE, before the synthetic success row is appended below: once that row is pushed,
  // `steps.length` no longer counts only the flow's own steps and the arithmetic is wrong.
  const halted = haltedFrom(steps, loaded.value.steps.length);
  /*
   * The whole-span pass, run once the journey is over. Best-effort by construction: a session stub
   * without `eventsSince` must not be able to abort a healthy replay, and a missing cross-step
   * finding is a smaller loss than a run that dies computing one.
   */
  const crossStep = ((): Contradiction[] => {
    try {
      const span = { since: replayFloor, until: session.elapsed() };
      const events = session.eventsSince(replayFloor).filter((e) => e.t >= replayFloor);
      return crossStepOnly(stepEffect(events, span).contradictions ?? [], steps);
    } catch {
      return [];
    }
  })();
  // "green means intent satisfied": when every step ran clean, assert the flow's success
  // end-condition as a real consequence. A signal/net success that never fires FAILS the replay
  // even though all locators resolved — the regression a healed-but-wrong locator ships green.
  const stepsClean = steps.length > 0 && steps.every((s) => s.ok && s.drift === undefined);
  if (stepsClean && loaded.value.success !== undefined) {
    const verdict = await assertSuccess(
      session,
      loaded.value.success,
      dynamicTestids(loaded.value),
      waitForPredicate,
      // The flow's own declaration, not the built-in floor: an app slow enough to need a longer
      // step wait is slow enough that its OUTCOME lands late too, and greening every step only to
      // fail the success oracle at 4s is the same false red one layer down.
      loaded.value.signalTimeoutMs ?? FLOW_SIGNAL_TIMEOUT_MS,
      replayFloor,
    );
    const row: FlowStepResult = {
      step: steps.length,
      tool: SUCCESS_STEP_TOOL,
      anchor: successLabel(loaded.value.success),
      ok: verdict.pass,
      ...(verdict.pass ? {} : { error: verdict.failureReason ?? 'flow.success not satisfied' }),
    };
    steps.push(row);
  }
  const driftSteps = steps.filter((s) => s.drift !== undefined).length;
  const allOk = steps.every((s) => s.ok);
  const status = driftSteps > 0 ? ReplayStatus.DRIFT : allOk ? ReplayStatus.OK : ReplayStatus.ERROR;
  await recordReplayRun(
    deps,
    name,
    status,
    driftSteps,
    deps.now() - startedAt,
    projectId,
    replayRoot,
  );
  // Anti-reward-hacking baseline: record what this flow asserted ONLY when it passed clean. A
  // failing run must never become the baseline a later weakening is measured against.
  if (status === ReplayStatus.OK) {
    await new AssertionTiersStore(deps.fs, replayRoot).recordPassing(
      name,
      loaded.value.steps.map((s, i) => ({
        step: i,
        ...(s.expect === undefined ? {} : { expect: s.expect }),
      })),
      // Record what this flow COVERS so a later deletion can be scoped to the files that changed.
      toFlowSources([{ name, steps: loaded.value.steps }])[0]?.sources ?? [],
    );
    // The ledger learns what this run proved. Only a flow that COULD have gone red discharges: an
    // assertion-free flow is never bound, and `dischargeIntent` refuses an unbound intent, so the
    // guard here is the cheap half of a rule the ledger already enforces. `grade` is what makes a
    // later weakening visible — an intent re-proved by a weaker flow says so in the git diff.
    if (unverifiableReason(loaded.value, invokedFlows) === undefined) {
      const provedAt = deps.now();
      await dischargeFlowIntent(intents, loaded.value, {
        verdictId: flowReplayVerdictId(name, provedAt),
        grade: classifyFlowAssertions(loaded.value).grade,
        at: provedAt,
      });
    }
  }
  // Push-default: the deviation report over this drive's segments, learned across runs. Best-effort.
  const deviation = await computeReplayDeviation(deps, session, replayFloor, replayRoot);
  /*
   * What the team already knows about this flow, fetched on the agent's behalf.
   *
   * Attached to the FAILING path as well as the clean one, deliberately: a drift is exactly the
   * moment somebody needs to know what this feature is supposed to do and who established it. A
   * knowledge base you only see when everything is already fine is decoration.
   */
  // No projectId argument: the API key is already bound to one project server-side, so passing a
  // second opinion about which project this is would only create a way for the two to disagree.
  const knows = await consultProjectMemory(deps, loaded.value, replayRoot);
  const failed = steps.find((step) => !step.ok && step.drift === undefined);
  if (failed !== undefined) {
    const errored: FlowReplayResult = {
      name,
      status,
      steps,
      error: { code: ReplayStatus.ERROR, message: failed.error ?? 'flow action failed' },
    };
    errored.decision = buildDecision(errored, loaded.value, intentSaid, invokedFlows);
    applyStartPathHint(errored, startPathHint);
    if (deviation !== undefined) errored.deviation = deviation;
    if (knows !== undefined) errored.knows = knows;
    if (crossStep.length > 0) errored.crossStep = crossStep;
    return errored;
  }
  const result: FlowReplayResult = { name, status, steps };
  if (halted !== undefined) result.halted = halted;
  if (knows !== undefined) result.knows = knows;
  // A green that cannot go red is not a pass. `reticle_flow_verify` already refuses to count these,
  // via this same function -- a single-flow caller saw a bare `ok` and had no way to learn the flow
  // asserts nothing. Derived from the same helper on purpose: two copies of this judgement would
  // drift, and the sibling tools would then disagree about the same flow.
  const cannotFail =
    status === ReplayStatus.OK ? unverifiableReason(loaded.value, invokedFlows) : undefined;
  if (cannotFail !== undefined) result.unverifiable = { reason: cannotFail };
  if (status !== ReplayStatus.OK)
    result.decision = buildDecision(result, loaded.value, intentSaid, invokedFlows);
  applyStartPathHint(result, startPathHint);
  if (deviation !== undefined) result.deviation = deviation;
  if (crossStep.length > 0) result.crossStep = crossStep;
  /*
   * What this run taught the flow.
   *
   * Every contradiction this replay attributed to a step, plus the cross-step ones, compared with
   * what the flow already knew. A defect seen for the first time is remembered as OPEN and asserts
   * nothing; one the flow had open and this run did NOT see becomes GUARDED, and from then on its
   * return is a regression this flow reports by itself, with no new assertion written by hand.
   *
   * `observed` is deliberately tied to whether any step ran. A replay that drove nothing did not
   * find the app clean — it found nothing — and promoting on that would manufacture guards out of
   * an absence of evidence, which is the false green one level up.
   */
  const seenNow = [
    ...steps.flatMap((step, i) =>
      (step.contradictions ?? []).map((c) => ({ kind: c.kind, step: i })),
    ),
    ...crossStep.map((c) => ({ kind: c.kind, step: CROSS_STEP_INDEX })),
  ];
  /*
   * `observed` must mean "the channels reported", not "some steps ran".
   *
   * It was `steps.length > 0`, which is true of essentially every replay — including one where an
   * observer never attached and `seenNow` is empty because NOTHING WAS WATCHING. Two of those in a
   * row promoted an open defect to a guard, which is a guard minted from absence of evidence: the
   * exact failure `learnFromRun` refuses when it is told the truth, and cannot refuse when it is
   * told `steps.length > 0`.
   *
   * The digest is the honest signal. Its own contract says `total` is written unconditionally
   * "because a summary with no keys could not be told apart from one that was never computed" — so
   * a step carrying a digest is a step whose window was actually read, and a replay where no step
   * carries one observed nothing whatever its step count says.
   */
  const learning = learnFromRun({
    guards: loaded.value.learned ?? [],
    seen: seenNow,
    observed: steps.some((step) => step.digest !== undefined),
  });
  result.learned = learning.guards;
  if (learning.promoted.length > 0) result.promoted = learning.promoted;
  if (learning.regressed.length > 0) result.regressed = learning.regressed;
  /*
   * Write it back, or none of the above compounds.
   *
   * The point of learning is that the NEXT replay starts from it. A result field the flow file
   * never receives would make every run learn the same lesson from scratch, which is the state
   * this change exists to leave behind.
   *
   * Best-effort on purpose: a store that refuses the write must not turn a completed replay into a
   * failed one. The verdict is about the app; this is bookkeeping about the flow, and losing a
   * lesson is smaller than losing the run that produced it. Skipped entirely when nothing moved,
   * so a clean replay of a flow with nothing to learn does not rewrite a file for no reason.
   */
  return result;
}

/** A contradiction's identity for de-duplication: the rule that fired, and the evidence it fired on. */
function contradictionId(found: Contradiction): string {
  return `${found.kind}|${found.detail}`;
}

/**
 * The contradictions the whole-span pass found that no individual step could.
 *
 * A step's window closes when the step ends, so a request fired at step 2 and still unanswered at
 * step 5 is invisible to every per-step window: step 2's closed before the answer came and step 5
 * never saw it start. Re-running the detectors over the whole replay span finds those — and re-finds
 * everything the steps already reported, which is what the subtraction is for. Reporting a finding
 * twice teaches a reader that the count is noise.
 *
 * Exported for its own test: the subtraction is the whole rule, and it is pure.
 */
/** Cross-step findings belong to no single step; -1 is the address the suite verdict already uses. */
const CROSS_STEP_INDEX = -1;

export function crossStepOnly(
  whole: readonly Contradiction[],
  steps: readonly FlowStepResult[],
): Contradiction[] {
  const seen = new Set(steps.flatMap((step) => (step.contradictions ?? []).map(contradictionId)));
  return whole.filter((found) => !seen.has(contradictionId(found)));
}

/**
 * The deviation report over a replay's route segments — compared against the learned envelope, which is
 * then updated. Best-effort: any failure (disk, empty window) yields undefined, never breaking the replay.
 */
async function computeReplayDeviation(
  deps: ToolDeps,
  session: { eventsSince(cursor: number): ReticleEvent[] },
  floor: number,
  /** The APP's root — the same one the replay resolved eleven lines above the old call. */
  root: string,
): Promise<DeviationReport | undefined> {
  try {
    const segments = computeSegments(session.eventsSince(floor));
    if (0 === segments.length) return undefined;
    return await reportAndAccumulate(new EnvelopeStore(deps.fs, root), segments);
  } catch {
    return undefined;
  }
}

/** Fold a start-page-mismatch hint onto a non-passing replay's decision (the actionable next move). */
function applyStartPathHint(result: FlowReplayResult, hint: string | undefined): void {
  if (hint === undefined || result.decision === undefined) return;
  result.decision.suggestedFix = hint;
  result.decision.nextAction = hint;
}

/**
 * The connecting session's project, or undefined when no browser is attached. Flow tools use it to
 * scope storage to the current app on a shared daemon; resolving must NOT throw here (list/load are
 * documented to work headless), so a missing/unknown session degrades to the global/legacy store.
 *
 * Re-exported, not re-implemented. This file carried a BYTE-IDENTICAL second copy, and the two
 * drifted the moment `ProjectId` was threaded: `session-root`'s copy returned the brand while this
 * one returned `string`, so every flow tool importing from here was handed a widened value and lost
 * the brand one line after it was minted. Exactly the weak-annotation failure the brand's own doc
 * records against `RunStore.list()`.
 */
export { sessionProjectId } from '@/memory/project/session-root.js';
