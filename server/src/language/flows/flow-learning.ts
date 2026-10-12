import type { FlowReplayResult } from '@reticlehq/core';
import { runSavedFlow } from '@/hooks/driven-by.js';
import { asNumber, asString, mutationTargetsFor, perturbationFor } from '@reticlehq/core';
import { sessionPerturbationPort } from '@/surface/tools/lease-tools.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { flowsForSession } from './flow-store-for-session.js';
import { safeSessionTarget, type ProjectTarget } from '@/memory/project/session-root.js';
import { replayNamedFlow } from './flow-replay-run.js';
import { recordingSources, withLearnedSources } from './learned-sources.js';
import { ReplayStatus } from '@reticlehq/core';

function targetOf(deps: ToolDeps, args: Record<string, unknown>): ProjectTarget {
  return safeSessionTarget(deps, asString(args['sessionId']));
}

/**
 * Write back what a replay taught the flow, once the replay has finished writing its own.
 *
 * Deliberately OUTSIDE `replayNamedFlow`. Persisting from inside it broke the intent bookkeeping —
 * a replay records the intent it discharged on the same file, and a second writer in the middle of
 * that turned `proved` back into `bound`. The test that caught it is
 * `a passing replay marks the intent proved with the verdict that did it`, and the lesson is
 * general: a read-modify-write layered into someone else's transaction is a rollback wearing an
 * update's clothes.
 *
 * So this runs after the replay has returned and re-reads the flow first, merging only `learned`
 * onto whatever the file now says.
 *
 * Best-effort by construction: a store that refuses the write must not turn a completed replay into
 * a failed one. The verdict is about the app; this is bookkeeping about the flow, and losing a
 * lesson is a smaller loss than losing the run that produced it.
 */
export async function persistLearning(
  deps: ToolDeps,
  args: Record<string, unknown>,
  result: FlowReplayResult,
): Promise<FlowReplayResult> {
  const learned = result.learned;
  if (learned === undefined || 0 === learned.length) return result;
  const name = asString(args['flowName']) ?? '';
  if (0 === name.length) return result;
  try {
    const target = targetOf(deps, args);
    await flowsForSession(deps, target).flows.recordLearned(name, learned, target.projectId);
  } catch {
    // Bookkeeping only.
  }
  return result;
}

/**
 * Replay a flow AND keep what it learned. The entry point every ordinary replay should use.
 *
 * Every replay path must route through here, not `replayNamedFlow` — promotion needs CONSECUTIVE
 * clean runs, so a path that skips the write-back promotes nothing while still reporting `learned`
 * and `promoted`.
 *
 * Wrapped here rather than inside `replayNamedFlow`, for the reason `persistLearning` above gives:
 * persisting from inside it puts a second writer in the middle of the replay's own intent
 * bookkeeping and turns `proved` back into `bound`.
 *
 * ── WHO MUST NOT USE THIS ───────────────────────────────────────────────────────────────────────
 * Two callers replay deliberately BROKEN conditions and call `replayNamedFlow` directly on purpose:
 *
 * - mutation testing (`flow-mutate-tools.ts`) breaks the app to check the flow notices. Learning
 *   from that teaches the flow about a defect nobody shipped.
 * - the perturbed branch of the seed path slows the network to see what the flow does under stress.
 *   A finding that appears only under perturbation is not a fact about the app.
 *
 * Both write a finding that would then have to STOP appearing to be promoted — so the damage is not
 * a wrong guard today, it is a guard earned against a condition the app is never in.
 */
export async function replayAndLearn(
  deps: ToolDeps,
  /**
   * The tool's args, WHOLE.
   *
   * Narrowed to `{ flowName, sessionId }` in the first draft, which silently dropped
   * `confirmDangerous` — so a replay that had been authorised to drive a destructive control lost
   * that authorisation on its way through here and refused the step. `tools.flow-replay.test.ts`
   * caught it. `seed` and anything added later travel the same path, so the whole object goes.
   */
  args: Record<string, unknown>,
): Promise<FlowReplayResult> {
  let recorded: ReturnType<typeof recordingSources> | undefined;
  // A saved flow's steps were asked for by whoever recorded it: no outward gate on them.
  const result = await runSavedFlow(() =>
    replayNamedFlow(deps, args, (session) => {
      recorded = recordingSources(session);
      return recorded.session;
    }),
  );
  // Only a clean run teaches a file: a drifted step may have resolved to the wrong element.
  if (result.status === ReplayStatus.OK && recorded !== undefined && recorded.sources.size > 0) {
    await persistSources(deps, args, recorded.sources);
  }
  return await persistLearning(deps, args, result);
}

/** Write back the files a clean replay's anchors resolved to. Best-effort, as `persistLearning` is. */
export async function persistSources(
  deps: ToolDeps,
  args: Record<string, unknown>,
  sources: Parameters<typeof withLearnedSources>[1],
): Promise<void> {
  const name = asString(args['flowName']) ?? '';
  if (0 === name.length) return;
  try {
    const target = targetOf(deps, args);
    const { projectId } = target;
    const store = flowsForSession(deps, target).flows;
    const current = await store.load(name, projectId);
    // Read first so a flow that already names every file is never rewritten.
    if (!current.ok || withLearnedSources(current.value, sources) === undefined) return;
    await store.recordSources(name, sources, projectId);
  } catch {
    // Bookkeeping only.
  }
}

/** A replay, under seeded perturbation when `seed` asks for one; the page is always put back. */
export async function replaySeededOrNot(
  deps: ToolDeps,
  args: Record<string, unknown>,
  /** Where the perturbation port finds the page: the app's origin. */
  appUrl: string | undefined,
): Promise<FlowReplayResult> {
  const seed = asNumber(args['seed']);
  if (seed === undefined) return await replayAndLearn(deps, args);
  /*
   * The targets are the endpoints the FLOW declared it depends on, so the perturbation lands on
   * traffic the flow claims to care about. No declared endpoints means nothing to slow, and the
   * replay runs clean rather than pretending a seed did something. `finally` is not tidiness: a
   * page left slowed is damage the NEXT run inherits, as a mystery.
   */
  const target = targetOf(deps, args);
  const loaded = await flowsForSession(deps, target)
    .flows.load(asString(args['flowName']) ?? asString(args['flow']) ?? '', target.projectId)
    .catch(() => null);
  const targets = loaded !== null && loaded.ok ? mutationTargetsFor(loaded.value) : [];
  const rules = perturbationFor(seed, targets);
  const port =
    0 === rules.length ? undefined : await sessionPerturbationPort(deps.realInput, appUrl);
  if (port === undefined) return replayAndLearn(deps, args);
  try {
    await port.slow(rules);
    const replay = await runSavedFlow(() => replayNamedFlow(deps, args));
    return { ...replay, perturbed: rules } as FlowReplayResult;
  } finally {
    await port.clear().catch(() => undefined);
  }
}
