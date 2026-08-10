/**
 * The native-input attempt — everything that decides whether a pointer action is driven through a
 * real input provider or falls back to the occlusion-honest synthetic path, and WHY.
 *
 * Split out of act-tools.ts along its natural seam: the act tools care only about the outcome
 * (`result` defined = it went native), never about provider availability, box resolution,
 * drag-target inspection or the reason taxonomy.
 */
import { ActionType, InputModeReason, ReticleCommand } from '@reticlehq/core';
import type { Session } from '../session/session.js';
import type { ElementBox, RealInputArgs } from '../input/real-input.js';
import { isPointerAction } from '../input/real-input.js';
import { assertDragNotDestructive, assertNotDestructive } from './act-danger.js';
import { NATIVE_INPUT_ARG } from '@reticlehq/core';
import { asString, asRecord } from './tools-helpers.js';
import { type ToolDeps, commandOrThrow } from './tool-kit.js';
import { asBox } from './act-helpers.js';

interface RealActResult {
  /** Defined only on a successful native action; `undefined` means the synthetic path runs. */
  result: unknown;
  settled: boolean;
  /** Set when a provider was available but threw — surfaces the fallback to the agent. */
  fellBack?: boolean;
  /** Why we went synthetic despite a configured provider (field bug #2: never a silent fallback). */
  reason?: InputModeReason;
}

/** Synthetic outcome with a diagnostic reason (provider configured but native input skipped). */
function synthetic(reason?: InputModeReason): RealActResult {
  return reason === undefined
    ? { result: undefined, settled: false }
    : { result: undefined, settled: false, reason };
}

/**
 * Attempt to drive a pointer action via native input. Returns a synthetic outcome (with a
 * `reason` when a provider is configured) whenever the synthetic path should run — no matching
 * page, unresolvable box, declined, etc. A throw inside the provider becomes a synthetic fallback
 * flagged with `fellBack`. `result` is defined only on a real success.
 */
export async function tryRealInput(
  deps: ToolDeps,
  session: Session,
  ref: string,
  action: ActionType,
  args: Record<string, unknown>,
): Promise<RealActResult> {
  const provider = deps.realInput;
  const inner = asRecord(args['args']);
  const askedForNative = true === inner[NATIVE_INPUT_ARG];
  if (provider === undefined) {
    // Silent by default: with no provider EVERY action is synthetic, and a reason on all of them is
    // noise on the most-used tool in the product. But an agent that passed native:true asked a
    // question and got the opposite answer — reported from the field as a silent downgrade that cost
    // real debugging time, because the tool description promises a reason is "never silent".
    return askedForNative ? synthetic(InputModeReason.NOT_CONFIGURED) : synthetic();
  }
  if (!isPointerAction(action)) return synthetic(InputModeReason.NOT_POINTER); // fill/type stay synthetic

  // "Don't click, run the code": a click/dblclick runs the occlusion-honest SYNTHETIC path by default
  // even with a provider configured — no coordinate gesture to be intercepted by the HUD or missed
  // off-screen. Opt into a trusted native click with args.native:true (file pickers, clipboard,
  // isTrusted-gated handlers). hover/drag genuinely need native pointer state, so they stay real.
  if ((action === ActionType.CLICK || action === ActionType.DBLCLICK) && !askedForNative) {
    return synthetic(InputModeReason.SYNTHETIC_CLICK_PREFERRED);
  }

  if (!(await provider.isAvailableFor(session.url)))
    return synthetic(InputModeReason.PAGE_NOT_CORRELATED);

  const inspected = await commandOrThrow(deps, session.id, ReticleCommand.INSPECT, { ref });
  assertNotDestructive(action, inner, inspected);
  const box = asBox(inspected);
  if (box === undefined) return synthetic(InputModeReason.ELEMENT_NOT_LOCATABLE);

  let toBox: ElementBox | undefined;
  if (action === ActionType.DRAG) {
    const toRef = asString(inner['toRef']);
    if (toRef === undefined) return synthetic(InputModeReason.DRAG_TARGET_UNRESOLVED);
    const targetInspected = await commandOrThrow(deps, session.id, ReticleCommand.INSPECT, {
      ref: toRef,
    });
    // A drag is judged on BOTH ends: dropping onto "Trash" is destructive however innocent the
    // thing being dragged looks.
    assertDragNotDestructive(inner, inspected, targetInspected);
    toBox = asBox(targetInspected);
    if (toBox === undefined) return synthetic(InputModeReason.DRAG_TARGET_UNRESOLVED);
  }

  const performArgs: RealInputArgs = {};
  const value = asString(inner['value']);
  if (value !== undefined) performArgs.value = value;
  const text = asString(inner['text']);
  if (text !== undefined) performArgs.text = text;
  if (toBox !== undefined) performArgs.toBox = toBox;

  try {
    const performed = await provider.perform(session.url, action, box, performArgs);
    if (!performed.performed) return synthetic(InputModeReason.PROVIDER_DECLINED);
    return { result: { performed: true, center: performed.center, action }, settled: true };
  } catch {
    return {
      result: undefined,
      settled: false,
      fellBack: true,
      reason: InputModeReason.PROVIDER_ERROR,
    };
  }
}
