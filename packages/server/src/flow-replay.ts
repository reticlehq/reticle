import {
  AnchorKind,
  DriftReason,
  IrisCommand,
  QueryBy,
  type CommandResult,
  type Drift,
  type FlowAnchor,
  type FlowFile,
  type FlowStep,
  type FlowStepResult,
  type IrisEvent,
  type QueryEmptyHint,
} from '@iris/protocol';
import type { EvalResult, Predicate } from './predicate.js';
import { asRecord, asString } from './tools-helpers.js';

/**
 * The session surface flow-replay needs: QUERY to re-resolve a testid anchor against the live
 * DOM, ACT to run the step, and the event/onEvent pair so a signal anchor can wait on a predicate
 * (via the injected waitForPredicate). Mirrors PredicateSession so the same fake drives both.
 */
export interface FlowReplaySession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  eventsSince(cursor: number): IrisEvent[];
  onEvent(listener: (event: IrisEvent) => void): () => void;
}

/** The injected predicate-waiter (the real waitForPredicate) — reused, never reimplemented. */
export type WaitForSignal = (
  session: FlowReplaySession,
  predicate: Predicate,
  timeoutMs: number,
) => Promise<EvalResult>;

/**
 * A single ASCII-ish edit distance (case-insensitive). Small inputs (testids), so O(n*m) is fine.
 * Exported so the SELFHEAL proposal layer derives its confidence from the SAME distance used to
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
        knownEmptyState: hint['knownEmptyState'] === true,
      },
    };
  }
  return { refs };
}

/** Build the legible-drift record for a testid anchor that resolved to zero live elements. */
function testidDrift(value: string, hint: QueryEmptyHint | undefined): Drift {
  return {
    reasonKind: DriftReason.TESTID_NOT_FOUND,
    reason: `testid "${value}" not found`,
    anchor: value,
    nearest: nearestTestid(value, hint?.presentTestids ?? []),
  };
}

/** The testid value of a step's primary anchor, for labelling the result row. */
function anchorLabel(anchor: FlowAnchor): string {
  if (anchor.kind === AnchorKind.TESTID) return anchor.value;
  if (anchor.kind === AnchorKind.SIGNAL) return anchor.name;
  return anchor.name ?? anchor.role;
}

/** Run one testid-anchored step: re-resolve via QUERY, then ACT on the live ref, else drift. */
async function runTestidStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  value: string,
  dynamic: ReadonlySet<string>,
): Promise<FlowStepResult> {
  const queryResult = await session.command(IrisCommand.QUERY, { by: QueryBy.TESTID, value });
  const { refs, hint } = readQuery(queryResult);
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
  const act = await session.command(IrisCommand.ACT, {
    ref,
    action: step.action ?? '',
    args: step.args ?? {},
  });
  const result: FlowStepResult = { step: index, tool: step.tool, anchor: value, ok: act.ok };
  if (!act.ok) {
    result.error = act.error ?? 'command failed';
    if (note !== undefined) result.note = note;
    return result;
  }
  // M8 Stage B ANNOTATE: assert the step's expect.element testid is present AFTER the action —
  // unless that testid was marked DYNAMIC (the LLM-output case), in which case its presence/content
  // is NOT asserted (only the action ran). The skip is scoped strictly to the dynamic set.
  const expectTestid = step.expect?.element?.testid;
  if (expectTestid !== undefined && !dynamic.has(expectTestid)) {
    const expectQuery = await session.command(IrisCommand.QUERY, {
      by: QueryBy.TESTID,
      value: expectTestid,
    });
    const expectRefs = readQuery(expectQuery);
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
 * a stale ref. A testid anchor is re-found by iris_query; a signal anchor waits on a predicate.
 * On the first anchor MISS the step carries legible drift and replay STOPS, returning the partial
 * results. This is the "whose fault is it" contract, not a blind "command failed".
 */
export async function replayFlow(
  session: FlowReplaySession,
  flow: FlowFile,
  waitForSignal: WaitForSignal,
  signalTimeoutMs: number,
): Promise<FlowStepResult[]> {
  const results: FlowStepResult[] = [];
  // M8 Stage B ANNOTATE: testids whose region is LLM-dynamic — their expect-presence is NOT asserted.
  const dynamic = new Set<string>(
    (flow.dynamic ?? [])
      .filter((a) => a.kind === AnchorKind.TESTID)
      .map((a) => (a.kind === AnchorKind.TESTID ? a.value : '')),
  );
  let index = 0;
  for (const step of flow.steps) {
    const label = anchorLabel(step.anchor);
    let result: FlowStepResult;
    if (step.anchor.kind === AnchorKind.SIGNAL) {
      result = await runSignalStep(session, step, index, label, waitForSignal, signalTimeoutMs);
    } else {
      result = await runTestidStep(session, step, index, label, dynamic);
    }
    results.push(result);
    if (result.drift !== undefined || !result.ok) break;
    index += 1;
  }
  return results;
}
