import {
  ActionType,
  DANGEROUS_ACTION_CONFIRM_ARG,
  NATIVE_INPUT_ARG,
  OutwardAction,
  isDangerousActionText,
  isDangerousNavigation,
  isInertHref,
  isPaymentProviderUrl,
  outwardActionOf,
  outwardRefusal,
  withoutFilenameTokens,
} from '@reticlehq/core';
import { currentDrivenBy, harnessOutwardAllowed } from '@/hooks/driven-by.js';
import { asRecord, asString } from '@reticlehq/core';

/**
 * Refuse to drive a money-moving or destructive control by accident.
 *
 * A native click is indistinguishable from a user's, so an agent exploring an unfamiliar app can
 * refund a payment or delete an account while "just looking". The guard reads every text surface the
 * control exposes — its name, its text, its value, where it points, and the form it submits — because
 * a button labelled only with an icon still says what it does through its `formAction`.
 *
 * Opt in per action with `args.confirmDangerous: true`. Deliberately a THROW rather than a warning:
 * a caller that has not thought about it must not proceed by ignoring a field.
 */
function descriptorText(value: unknown): string {
  const descriptor = asRecord(value);
  // Filename tokens are stripped from the name, the text and the value only: an href or a
  // formAction is a target, not words on the control, and its destination must be read whole.
  return [
    withoutFilenameTokens(asString(descriptor['name']) ?? ''),
    withoutFilenameTokens(asString(descriptor['text']) ?? ''),
    withoutFilenameTokens(asString(descriptor['value']) ?? ''),
    asString(descriptor['href']) ?? '',
    asString(descriptor['formAction']) ?? '',
    asString(descriptor['formText']) ?? '',
  ].join(' ');
}

function descriptorRole(value: unknown): string | undefined {
  const role = asString(asRecord(value)['role']);
  return role !== undefined && role.length > 0 ? role : undefined;
}

function isDestructiveDescriptor(value: unknown): boolean {
  // A real link is a navigation, judged by where it goes: the same rule as the SDK path.
  const href = asString(asRecord(value)['href']);
  if (href !== undefined && !isInertHref(href)) {
    return isDangerousNavigation(href);
  }
  return isDangerousActionText(descriptorText(value), descriptorRole(value));
}

/** A Harness call presses an outward control only when its journey asked (`harnessOutwardAllowed`). */
function assertOutwardAllowed(...descriptors: unknown[]): void {
  const allowed = harnessOutwardAllowed();
  if (allowed === undefined) {
    return;
  }
  for (const descriptor of descriptors) {
    const kind = outwardActionOf(descriptorText(descriptor), descriptorRole(descriptor));
    if (kind !== undefined && !allowed.includes(kind)) {
      throw new Error(outwardRefusal(kind));
    }
  }
}

/** A Harness call goes to a payment provider's origin only when its journey asked to pay. */
export function assertNotPaymentNavigation(url: string): void {
  const allowed = harnessOutwardAllowed();
  if (allowed === undefined || allowed.includes(OutwardAction.PAY)) {
    return;
  }
  if (isPaymentProviderUrl(url)) {
    throw new Error(outwardRefusal(OutwardAction.PAY));
  }
}

export function assertNotDestructive(
  action: ActionType,
  innerArgs: Record<string, unknown>,
  inspected: unknown,
): void {
  if (action !== ActionType.CLICK && action !== ActionType.DBLCLICK) {
    return;
  }
  assertOutwardAllowed(inspected);
  if (true === innerArgs[DANGEROUS_ACTION_CONFIRM_ARG]) {
    return;
  }
  if (!isDestructiveDescriptor(inspected)) {
    return;
  }
  throw new Error(
    `potentially destructive native action blocked; retry with args.${DANGEROUS_ACTION_CONFIRM_ARG}=true`,
  );
}

/**
 * A drag is judged on BOTH ends. Dropping a harmless row onto "Delete" is destructive, and the
 * source alone never says so. Each end is classified on its own text and role, so a Payment
 * option dragged onto Save is not a payment.
 */
export function assertDragNotDestructive(
  innerArgs: Record<string, unknown>,
  from: unknown,
  to: unknown,
): void {
  assertOutwardAllowed(from, to);
  if (true === innerArgs[DANGEROUS_ACTION_CONFIRM_ARG]) {
    return;
  }
  if (!isDestructiveDescriptor(from) && !isDestructiveDescriptor(to)) {
    return;
  }
  throw new Error(
    `potentially destructive native action blocked; retry with args.${DANGEROUS_ACTION_CONFIRM_ARG}=true`,
  );
}

/**
 * `reticle_act_and_wait` cannot drive native input, and used to take `args.native` and ignore it.
 *
 * An open `args` passthrough accepted the field, the handler drove the page through the SDK anyway,
 * and the result claimed success — so an agent asking for the one thing a synthetic click cannot do
 * (a file picker, the clipboard, an `isTrusted`-gated handler) got a synthetic click and no hint
 * that its request had been dropped. A silently ignored argument is a false promise; refusing with
 * the route that DOES work is the honest answer.
 */
export const NATIVE_INPUT_UNSUPPORTED =
  `reticle_act_and_wait cannot drive native input, so args.${NATIVE_INPUT_ARG} would be ignored. ` +
  `Use reticle_act { args: { ${NATIVE_INPUT_ARG}: true } } for the trusted click, then assert the ` +
  'consequence with reticle_assert / reticle_observe using the `since` cursor it returns.';

/** Refuse rather than silently drop a native-input request the act-then-wait path cannot honour. */
export function assertNativeInputSupported(innerArgs: Record<string, unknown>): void {
  if (true === innerArgs[NATIVE_INPUT_ARG]) {
    throw new Error(NATIVE_INPUT_UNSUPPORTED);
  }
}

/**
 * The agent's own declaration counts as the confirmation, for that one control.
 *
 * `reticle_act_and_wait { target: { role: "button", name: "Place order" }, until }` names the
 * control by the very words the guard flags AND names the consequence before acting: asking again
 * for `confirmDangerous` cost a round trip per step on a shop's ordinary path and protected nothing.
 * A `ref` or `testid` does not count — neither says what the control does, and a stale ref is
 * exactly how the wrong button gets pressed. A Harness call never takes this path: its outward
 * guard decides alone.
 */
export function confirmedByDeclaration(
  innerArgs: Record<string, unknown>,
  target: unknown,
  declared: boolean,
): Record<string, unknown> {
  if (!declared || true === innerArgs[DANGEROUS_ACTION_CONFIRM_ARG]) {
    return innerArgs;
  }
  if (currentDrivenBy() !== undefined) {
    return innerArgs;
  }
  const named = asRecord(target);
  // The words must themselves be the dangerous ones: naming "Continue" on a button whose form posts
  // to /delete-account consents to nothing, and the guard still reads the whole control.
  const words = ['name', 'text', 'label'].map((key) => asString(named[key]) ?? '').join(' ');
  return isDangerousActionText(words, asString(named['role']))
    ? { ...innerArgs, [DANGEROUS_ACTION_CONFIRM_ARG]: true }
    : innerArgs;
}
