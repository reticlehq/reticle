/**
 * Turn what the caller named into a ref: `ref` outright, or `target` via one page query.
 *
 * Split out of act-tools.ts when it crossed the 1000-line cap. Chosen deliberately over the ACT
 * dispatcher, which looks like the more obvious seam and is not: `dispatch-attribution` asserts
 * file-by-file that anything sending an ACT also opens an attribution window, so moving the
 * dispatch out of the file that opens the window would have weakened a real invariant to satisfy a
 * line count. This resolves a TARGET and dispatches only QUERY, so that guard is untouched.
 */
import { ReticleCommand, isGlobalPressCall } from '@reticlehq/core';
import type { Session } from '@/portal/session/session.js';
import { normalizeQueryArgs } from '@/surface/tools/read/query-shape.js';
import { resolveTargetRef, type TargetResolution } from './resolve-target.js';
import { asRecord, asString, asNumber } from '@reticlehq/core';
import { appearanceDecision } from '@reticlehq/engine/window/appearance-budget.js';

/**
 * A press of Escape, Tab, or a modifier shortcut is a document key. Requiring a locator for it
 * forced a snapshot just to name an element the keystroke is not about.
 */
const MISSING_ACT_TARGET =
  'pass `ref` (from reticle_query/reticle_snapshot) or `target` (e.g. { testid } or { role, name }). ' +
  'A press of Escape, Tab, or a modifier shortcut is a document key and needs neither.';

/**
 * Resolve an action's element: an explicit `ref`, or a `target` query resolved in the SAME call.
 *
 * Requiring a ref meant every verification paid a `reticle_query` turn first just to learn one
 * string, and the advertised tool surface is re-sent on every turn — measured on the wire, a
 * two-turn verification spent 10,756 of 11,235 tokens on schema and 479 on the actual answers. The
 * lookup still happens; it just stops costing a round trip through the model.
 *
 * `ref` wins when both are given, because it is the more specific instruction and silently
 * preferring the query would act on something the caller did not name.
 *
 * A document-key press (Escape, Tab, a modifier shortcut) is the one action that is not aimed at
 * an element. It resolves to `{ kind: 'global' }` rather than refusing, so dismissing a dialog
 * does not cost a snapshot.
 */
/**
 * How long a named element may take to appear before the step gives up.
 *
 * Matches `act_and_wait`'s own settle budget: a step that waits for its element and then waits for
 * its consequence should not be slow twice for two different reasons.
 */
const DEFAULT_APPEARANCE_MS = 8_000;

export async function resolveActTarget(
  session: Session,
  args: Record<string, unknown>,
  /**
   * How long a named element may take to appear. Passed in rather than read from `args`, because
   * the budget belongs to the CALL and the args here are one STEP of it — reading it from the step
   * silently defaulted every batched step to the full budget while the caller's `timeout_ms: 0`
   * was ignored.
   */
  appearanceMs?: number,
): Promise<TargetResolution> {
  const ref = asString(args['ref']);
  if (ref !== undefined && ref.length > 0) return { kind: 'ref', ref };
  const target = args['target'];
  if (target === undefined) {
    if (isGlobalPressCall(args)) return { kind: 'global', ref: '' };
    return { kind: 'error', message: MISSING_ACT_TARGET };
  }
  const q = normalizeQueryArgs(asRecord(target));
  /*
   * Look again while the step's own budget lasts, instead of once.
   *
   * A batched journey names every step's element up front, and the element a later step acts on
   * often does not exist when the batch is submitted — the modal step 1 opens, the row step 2
   * creates. One query fails those instantly, and that single behaviour is why an agent gives up on
   * batching and pays a model turn per step: snapshot, act, snapshot, act.
   *
   * `appearanceDecision` holds the safety rule and holds it FIRST: zero matches may be waited for,
   * because nothing else could be acted on meanwhile, but MORE THAN ONE is refused immediately and
   * is never waited out. Given time an ambiguous name can resolve to whichever element the race
   * settled on, and that is a coin toss the caller never saw.
   *
   * `budgetMs` of 0 means the caller asked never to wait, and that still holds.
   */
  const budgetMs = Math.max(
    0,
    appearanceMs ?? asNumber(args['timeout_ms']) ?? DEFAULT_APPEARANCE_MS,
  );
  const startedAt = Date.now();
  for (;;) {
    const out = await session.command(ReticleCommand.QUERY, {
      by: q['by'],
      value: q['value'],
      name: q['name'],
      scope: q['scope'],
    });
    if (!out.ok) return { kind: 'error', message: out.error ?? 'target query failed' };
    const elements = asRecord(out.result)['elements'];
    const found = Array.isArray(elements) ? elements : [];
    const decision = appearanceDecision({
      matches: found.length,
      elapsedMs: Date.now() - startedAt,
      budgetMs,
    });
    // One match, or an ambiguity: both are answered by the existing resolver, which already ranks
    // candidates inside its refusal so the next turn needs no snapshot.
    if ('wait' !== decision.do) return resolveTargetRef(found);
    await new Promise((resolve) => setTimeout(resolve, decision.waitMs));
  }
}
