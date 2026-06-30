import {
  AnchorKind,
  DriftReason,
  EventType,
  ReticleCommand,
  QueryBy,
  type CommandResult,
  type Drift,
  type FlowAnchor,
  type FlowExpect,
  type FlowFile,
  type FlowStep,
  type FlowStepResult,
  type ReticleEvent,
  type QueryEmptyHint,
} from '@reticle/protocol';
import type { EvalResult, Predicate } from '../events/predicate.js';
import { asRecord, asString } from '../tools/tools-helpers.js';
import { replayActionArgs } from './replay.js';

/**
 * The session surface flow-replay needs: QUERY to re-resolve a testid anchor against the live
 * DOM, ACT to run the step, and the event/onEvent pair so a signal anchor can wait on a predicate
 * (via the injected waitForPredicate). Mirrors PredicateSession so the same fake drives both.
 */
export interface FlowReplaySession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  eventsSince(cursor: number): ReticleEvent[];
  onEvent(listener: (event: ReticleEvent) => void): () => void;
  /** Buffer clock (ms since connect) — required by the predicate engine's `settled` check. */
  elapsed(): number;
}

/**
 * The injected predicate-waiter (the real waitForPredicate) — reused, never reimplemented.
 * `since` is the event-time floor (default 0 = whole buffer): pass the cursor captured before a
 * replay so the success oracle can't be satisfied by a stale signal from a prior replay/run.
 */
export type WaitForSignal = (
  session: FlowReplaySession,
  predicate: Predicate,
  timeoutMs: number,
  since?: number,
) => Promise<EvalResult>;

/**
 * A single ASCII-ish edit distance (case-insensitive). Small inputs (testids), so O(n*m) is fine.
 * Exported so the heal proposal layer derives its confidence from the SAME distance used to
 * pick `nearest` — no second, divergent heuristic enters the trust boundary.
 */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const rows = s.length + 1;
  const cols = t.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j < cols; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[cols - 1] ?? 0;
}

/**
 * The closest present testid to a missing one, by case-insensitive edit distance, ties broken
 * by shortest length then lexically. Returns null only when nothing is present — so a drift
 * record always names a fix when one exists ("whose fault is it": here is the closest survivor).
 */
export function nearestTestid(missing: string, present: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of present) {
    const distance = editDistance(missing, candidate);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== null && candidate.length < best.length) ||
      (distance === bestDistance &&
        best !== null &&
        candidate.length === best.length &&
        candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Bounded settle for anchor re-resolution. A testid step queries the live DOM for the anchor; if a
 * render is still in flight (post-login route swap, modal mount, list paint) the element exists but
 * isn't painted yet, and a single QUERY would read zero and FALSELY drift. We re-query a few times
 * with a short delay before concluding the anchor is gone — a real regression (renamed/removed
 * testid) stays missing across every attempt, so this removes flakiness without masking breaks.
 */
const ANCHOR_SETTLE_ATTEMPTS = 8;
const ANCHOR_SETTLE_DELAY_MS = 150;

/** Injected sleeper so tests drive replay with a no-op clock; production waits on a real timer. */
type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Extract the live element refs + the zero-match near-miss hint from a QUERY command result. */
function readQuery(result: CommandResult): { refs: string[]; hint?: QueryEmptyHint } {
  if (!result.ok) return { refs: [] };
  const payload = asRecord(result.result);
  const elements = Array.isArray(payload['elements']) ? payload['elements'] : [];
  const refs = elements.map((e) => asString(asRecord(e)['ref']) ?? '').filter((r) => r.length > 0);
  const rawHint = payload['hint'];
  if (typeof rawHint === 'object' && rawHint !== null) {
    const hint = asRecord(rawHint);
    const present = Array.isArray(hint['presentTestids'])
      ? hint['presentTestids'].filter((t): t is string => typeof t === 'string')
      : [];
    return {
      refs,
      hint: {
        route: asString(hint['route']) ?? '',
        presentTestids: present,
        presentRegions: [],
        knownEmptyState: hint['knownEmptyState'] === true,
      },
    };
  }
  return { refs };
}

/**
 * True when ≥2 present testids tie at the minimum edit distance to the missing one — `nearest` is
 * then an arbitrary lexical-tiebreak pick, so auto-healing would be a coin-flip between candidates.
 * Such a drift is surfaced (with a nearest) but never auto-healed.
 */
export function nearestIsAmbiguous(missing: string, present: string[]): boolean {
  if (present.length < 2) return false;
  let min = Number.POSITIVE_INFINITY;
  let count = 0;
  for (const candidate of present) {
    const distance = editDistance(missing, candidate);
    if (distance < min) {
      min = distance;
      count = 1;
    } else if (distance === min) {
      count += 1;
    }
  }
  return count >= 2;
}

/** Build the legible-drift record for a testid anchor that resolved to zero live elements. */
function testidDrift(value: string, hint: QueryEmptyHint | undefined): Drift {
  const present = hint?.presentTestids ?? [];
  const drift: Drift = {
    reasonKind: DriftReason.TESTID_NOT_FOUND,
    reason: `testid "${value}" not found`,
    anchor: value,
    nearest: nearestTestid(value, present),
  };
  if (nearestIsAmbiguous(value, present)) drift.ambiguous = true;
  return drift;
}

/**
 * Re-resolve any QUERY against the live DOM, tolerating an in-flight render: QUERY, and while it
 * returns zero refs, sleep and retry up to ANCHOR_SETTLE_ATTEMPTS. Returns as soon as refs appear,
 * so a present anchor costs one query; a genuinely missing one costs the full (bounded) settle and
 * then drifts. The last result's near-miss hint is returned for the drift record.
 */
async function resolveQuery(
  session: FlowReplaySession,
  queryArgs: Record<string, unknown>,
  sleep: Sleep,
): Promise<{ refs: string[]; hint?: QueryEmptyHint }> {
  let last = readQuery(await session.command(ReticleCommand.QUERY, queryArgs));
  for (let attempt = 1; last.refs.length === 0 && attempt < ANCHOR_SETTLE_ATTEMPTS; attempt += 1) {
    await sleep(ANCHOR_SETTLE_DELAY_MS);
    last = readQuery(await session.command(ReticleCommand.QUERY, queryArgs));
  }
  return last;
}

/** Re-resolve a testid anchor. */
function resolveTestid(
  session: FlowReplaySession,
  value: string,
  sleep: Sleep,
): Promise<{ refs: string[]; hint?: QueryEmptyHint }> {
  return resolveQuery(session, { by: QueryBy.TESTID, value }, sleep);
}

/**
 * The route (pathname) currently in effect — the page a step runs on. Reads the latest ROUTE_CHANGE
 * from the whole event buffer; mirrors the predicate engine's route field order (pathname → to).
 * Returns undefined when no route has been observed (e.g. a fake session) so `page` stays optional.
 */
function currentRoute(session: FlowReplaySession): string | undefined {
  const routes = session.eventsSince(0).filter((e) => e.type === EventType.ROUTE_CHANGE);
  const last = routes.at(-1);
  if (last === undefined) return undefined;
  const data = last.data ?? {};
  const pathname = asString(data['pathname']) ?? asString(data['to']);
  return pathname !== undefined && pathname.length > 0 ? pathname : undefined;
}

/** Pathname only (drop origin + query) so a net URL stays terse in the journey. */
function trimUrl(url: string): string {
  try {
    return new URL(url, 'http://x').pathname;
  } catch {
    return url.length > 60 ? `${url.slice(0, 59)}…` : url;
  }
}

/**
 * A compact "what happened after this step" summary from the post-action event window — the
 * journey's consequence column ("→ /deployments", "signal modal:opened", "GET /api/x 500"). Notable
 * events only (route / domain signal / network / console error), terse and capped to stay token-cheap.
 */
function summarizeConsequence(events: ReticleEvent[]): string | undefined {
  const parts: string[] = [];
  const lastRoute = events.filter((e) => e.type === EventType.ROUTE_CHANGE).at(-1);
  if (lastRoute !== undefined) {
    const data = lastRoute.data ?? {};
    const to = asString(data['pathname']) ?? asString(data['to']);
    if (to !== undefined && to.length > 0) parts.push(`→ ${to}`);
  }
  const signals = new Set<string>();
  for (const e of events) {
    if (e.type !== EventType.SIGNAL) continue;
    const name = asString((e.data ?? {})['name']);
    if (name !== undefined) signals.add(name);
  }
  for (const name of [...signals].slice(0, 2)) parts.push(`signal ${name}`);
  for (const n of events.filter((e) => e.type === EventType.NET_REQUEST).slice(0, 2)) {
    const data = n.data ?? {};
    const method = asString(data['method']) ?? 'GET';
    const path = trimUrl(asString(data['url']) ?? '');
    const status = typeof data['status'] === 'number' ? ` ${data['status']}` : '';
    parts.push(`${method} ${path}${status}`.trim());
  }
  const errors = events.filter(
    (e) => e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT,
  ).length;
  if (errors > 0) parts.push(`${errors} console error${errors > 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/** A compact, legible label for a component auto-anchor (component@file:line, or its best part). */
function componentLabel(
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }>,
): string {
  if (anchor.source !== undefined) {
    const base = anchor.source.file.split('/').pop() ?? anchor.source.file;
    const loc = `${base}:${anchor.source.line}`;
    return anchor.component !== undefined ? `${anchor.component}@${loc}` : loc;
  }
  return anchor.component ?? anchor.name ?? anchor.role ?? 'component';
}

/** The value of a step's primary anchor, for labelling the result row. */
function anchorLabel(anchor: FlowAnchor): string {
  if (anchor.kind === AnchorKind.TESTID) return anchor.value;
  if (anchor.kind === AnchorKind.SIGNAL) return anchor.name;
  if (anchor.kind === AnchorKind.COMPONENT) return componentLabel(anchor);
  return anchor.name ?? anchor.role;
}

/** QUERY args for a component auto-anchor — source (precise) + component name (coarse) as given. */
function componentQueryArgs(
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }>,
): Record<string, unknown> {
  const args: Record<string, unknown> = { by: QueryBy.COMPONENT };
  if (anchor.component !== undefined) args['component'] = anchor.component;
  if (anchor.source !== undefined) args['source'] = anchor.source;
  return args;
}

/** Run one component-anchored step: re-resolve via QUERY by:'component', ACT on the live ref, else drift. */
async function runComponentStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }>,
  confirmDangerous: boolean,
  sleep: Sleep,
): Promise<FlowStepResult> {
  const label = componentLabel(anchor);
  const { refs } = await resolveQuery(session, componentQueryArgs(anchor), sleep);
  if (refs.length === 0) {
    return {
      step: index,
      tool: step.tool,
      anchor: label,
      ok: false,
      drift: {
        reasonKind: DriftReason.COMPONENT_NOT_FOUND,
        reason: `component anchor "${label}" not found`,
        anchor: label,
        nearest: null,
      },
    };
  }
  const ref = refs[0] ?? '';
  const act = await session.command(ReticleCommand.ACT, {
    ref,
    action: step.action ?? '',
    args: replayActionArgs(step.args, confirmDangerous),
  });
  const result: FlowStepResult = { step: index, tool: step.tool, anchor: label, ok: act.ok };
  if (!act.ok) result.error = act.error ?? 'command failed';
  return result;
}

/** Run one testid-anchored step: re-resolve via QUERY, then ACT on the live ref, else drift. */
async function runTestidStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  value: string,
  dynamic: ReadonlySet<string>,
  confirmDangerous: boolean,
  sleep: Sleep,
): Promise<FlowStepResult> {
  const { refs, hint } = await resolveTestid(session, value, sleep);
  if (refs.length === 0) {
    return {
      step: index,
      tool: step.tool,
      anchor: value,
      ok: false,
      drift: testidDrift(value, hint),
    };
  }
  const ref = refs[0] ?? '';
  const note = refs.length > 1 ? `ambiguous testid '${value}', used first match` : undefined;
  const act = await session.command(ReticleCommand.ACT, {
    ref,
    action: step.action ?? '',
    args: replayActionArgs(step.args, confirmDangerous),
  });
  const result: FlowStepResult = { step: index, tool: step.tool, anchor: value, ok: act.ok };
  if (!act.ok) {
    result.error = act.error ?? 'command failed';
    if (note !== undefined) result.note = note;
    return result;
  }
  // assert the step's expect.element testid is present AFTER the action —
  // unless that testid was marked DYNAMIC (the LLM-output case), in which case its presence/content
  // is NOT asserted (only the action ran). The skip is scoped strictly to the dynamic set.
  const expectTestid = step.expect?.element?.testid;
  if (expectTestid !== undefined && !dynamic.has(expectTestid)) {
    const expectRefs = await resolveTestid(session, expectTestid, sleep);
    if (expectRefs.refs.length === 0) {
      return {
        step: index,
        tool: step.tool,
        anchor: expectTestid,
        ok: false,
        drift: testidDrift(expectTestid, expectRefs.hint),
      };
    }
  }
  if (note !== undefined) result.note = note;
  return result;
}

/**
 * After a step's anchor resolves + its action runs, an `expect.state` additionally asserts STORE
 * TRUTH — the source of truth no DOM read can reach. Evaluated with the same predicate engine (waits
 * up to the timeout so an async store update can settle); a mismatch is legible drift, not a blind
 * fail. Returns the drift on mismatch, else undefined.
 */
async function assertStepState(
  session: FlowReplaySession,
  state: NonNullable<FlowExpect['state']>,
  waitForSignal: WaitForSignal,
  timeoutMs: number,
  since: number,
): Promise<Drift | undefined> {
  const predicate: Extract<Predicate, { kind: 'state' }> = { kind: 'state', path: state.path };
  if (state.store !== undefined) predicate.store = state.store;
  if (state.equals !== undefined) predicate.equals = state.equals;
  const verdict = await waitForSignal(session, predicate, timeoutMs, since);
  if (verdict.pass) return undefined;
  return {
    reasonKind: DriftReason.STATE_MISMATCH,
    reason: verdict.failureReason ?? `state '${state.path}' did not hold`,
    anchor: `state:${state.path}`,
    nearest: null,
  };
}

/** Run one signal-anchored step: wait for the signal predicate, else drift (no nearest for signals). */
async function runSignalStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  name: string,
  waitForSignal: WaitForSignal,
  signalTimeoutMs: number,
): Promise<FlowStepResult> {
  const verdict = await waitForSignal(session, { kind: 'signal', name }, signalTimeoutMs);
  if (verdict.pass) return { step: index, tool: step.tool, anchor: name, ok: true };
  return {
    step: index,
    tool: step.tool,
    anchor: name,
    ok: false,
    drift: {
      reasonKind: DriftReason.SIGNAL_NOT_OBSERVED,
      reason: `signal "${name}" not observed`,
      anchor: name,
      nearest: null,
    },
  };
}

/**
 * Replay a loaded flow by RE-RESOLVING every step's semantic anchor against the live DOM — never
 * a stale ref. A testid anchor is re-found by reticle_query; a signal anchor waits on a predicate.
 * On the first anchor MISS the step carries legible drift and replay STOPS, returning the partial
 * results. This is the "whose fault is it" contract, not a blind "command failed".
 */
export async function replayFlow(
  session: FlowReplaySession,
  flow: FlowFile,
  waitForSignal: WaitForSignal,
  signalTimeoutMs: number,
  confirmDangerous = false,
  sleep: Sleep = realSleep,
): Promise<FlowStepResult[]> {
  const results: FlowStepResult[] = [];
  // testids whose region is LLM-dynamic — their expect-presence is NOT asserted.
  const dynamic = new Set<string>(
    (flow.dynamic ?? [])
      .filter((a) => a.kind === AnchorKind.TESTID)
      .map((a) => (a.kind === AnchorKind.TESTID ? a.value : '')),
  );
  let index = 0;
  for (const step of flow.steps) {
    const label = anchorLabel(step.anchor);
    // The page this step runs on (the journey's "which page") — captured before the action.
    const page = currentRoute(session);
    // Event-time floor so the consequence reflects only THIS step's aftermath, not prior steps'.
    const cursorBefore = session.elapsed();
    let result: FlowStepResult;
    if (step.anchor.kind === AnchorKind.SIGNAL) {
      result = await runSignalStep(session, step, index, label, waitForSignal, signalTimeoutMs);
    } else if (step.anchor.kind === AnchorKind.COMPONENT) {
      result = await runComponentStep(session, step, index, step.anchor, confirmDangerous, sleep);
    } else {
      result = await runTestidStep(session, step, index, label, dynamic, confirmDangerous, sleep);
    }
    // A step may additionally assert STORE TRUTH (expect.state) once its action has run — caught
    // deterministically here, in the same cheap replay loop, with no LLM.
    if (result.ok && result.drift === undefined && step.expect?.state !== undefined) {
      const stateDrift = await assertStepState(
        session,
        step.expect.state,
        waitForSignal,
        signalTimeoutMs,
        cursorBefore,
      );
      if (stateDrift !== undefined) {
        result.ok = false;
        result.drift = stateDrift;
      }
    }
    if (page !== undefined) result.page = page;
    const consequence = summarizeConsequence(
      session.eventsSince(cursorBefore).filter((e) => e.t >= cursorBefore),
    );
    if (consequence !== undefined) result.consequence = consequence;
    results.push(result);
    if (result.drift !== undefined || !result.ok) break;
    index += 1;
  }
  return results;
}
