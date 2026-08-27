/**
 * The act plumbing all three acting tools share.
 *
 * Split out of `act-tools.ts` when that file passed the 1000-line backstop. A helper seam rather
 * than an arbitrary one: `reticle_act`, `reticle_act_and_wait` and `reticle_act_sequence` are three
 * different units of work, and these two functions are the part that is identical across them —
 * dispatching an action to the bridge, and turning a `target` into a ref before the action window
 * opens. The tools stayed together; what they have in common moved.
 */

import { normalizeQueryArgs } from './query-shape.js';
import { Session } from '../session/session.js';
import { resolveTargetRef, type TargetResolution } from './resolve-target.js';
import { z } from 'zod';
import { ActionType, ReticleCommand } from '@reticlehq/core';
import { asString, asRecord } from './tools-helpers.js';
import { rewriteUploadArgs } from './real-input-attempt.js';

/**
 * Single dispatch point for every ACT and ACT_SEQUENCE command.
 *
 * This is the seam the reviewer asked for: instead of wiring rewriteUploadArgs at three separate
 * call sites (reticle_act, reticle_act_and_wait, reticle_act_sequence) we intercept once here,
 * which also covers flow-replay, crawl, and any future dispatch site that goes through this helper.
 *
 * captureAct is called AFTER this, so the flow-recording captures the pre-rewrite args (the path
 * the agent actually wrote) rather than the base64 blob — replay would otherwise send 750 KiB of
 * base64 to the browser as if it were an inline content call.
 */
export async function actCommand(
  deps: Parameters<typeof rewriteUploadArgs>[0],
  session: {
    command: (
      name: string,
      args: Record<string, unknown>,
      timeout?: number,
    ) => Promise<import('@reticlehq/core').CommandResult>;
  },
  actArgs: Record<string, unknown>,
  timeoutMs?: number,
): Promise<import('@reticlehq/core').CommandResult> {
  const rewritten = await rewriteUploadArgs(
    deps,
    'string' === typeof actArgs['action'] ? actArgs['action'] : '',
    asRecord(actArgs['args']),
  );
  const bridgeArgs: Record<string, unknown> = { ...actArgs, args: rewritten };
  return timeoutMs !== undefined
    ? session.command(ReticleCommand.ACT, bridgeArgs, timeoutMs)
    : session.command(ReticleCommand.ACT, bridgeArgs);
}

/**
 * Narrow the wire's `action` to a real ActionType, or undefined.
 *
 * It used to be `asString(args['action']) ?? ''`, so an unknown or missing action became the empty
 * string and travelled on — reaching the browser as a command it could not perform, and reported back
 * as a generic failure rather than "that is not an action". Validate at the boundary, per the project's
 * unknown-plus-narrowing rule, so a typo is rejected where it can still be explained.
 */

/**
 * The action vocabulary, derived from ActionType — never retyped.
 *
 * The description used to list thirteen actions while ActionType had seventeen: blur, upload, drag
 * and webmcp were real, callable, and undocumented, because a hand-copied list drifts the moment
 * someone adds an arm. Deriving both the schema and the prose from the enum makes that impossible.
 *
 * The handler already refused an unknown action with a good message; the schema now refuses it
 * one layer earlier, before any session is resolved or any work is done.
 */
export const ACTION_TYPE_VALUES = Object.values(ActionType);
export const ACTION_TYPE_LIST = ACTION_TYPE_VALUES.join(' | ');
export const actionTypeEnum = z.enum(ACTION_TYPE_VALUES as [string, ...string[]]);

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
 */
export async function resolveActTarget(
  session: Session,
  args: Record<string, unknown>,
): Promise<TargetResolution> {
  const ref = asString(args['ref']);
  if (ref !== undefined && ref.length > 0) return { kind: 'ref', ref };
  const target = args['target'];
  if (target === undefined) {
    return {
      kind: 'error',
      message:
        'pass `ref` (from reticle_query/reticle_snapshot) or `target` (e.g. { testid } or { role, name }).',
    };
  }
  const q = normalizeQueryArgs(asRecord(target));
  const out = await session.command(ReticleCommand.QUERY, {
    by: q['by'],
    value: q['value'],
    name: q['name'],
    scope: q['scope'],
  });
  if (!out.ok) return { kind: 'error', message: out.error ?? 'target query failed' };
  const elements = asRecord(out.result)['elements'];
  return resolveTargetRef(Array.isArray(elements) ? elements : []);
}
