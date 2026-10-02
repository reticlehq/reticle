import {
  ActionType,
  DANGEROUS_ACTION_CONFIRM_ARG,
  NATIVE_INPUT_ARG,
  classifyActionText,
  type LinkAttributes,
} from '@reticlehq/core';
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
  return [
    asString(descriptor['name']) ?? '',
    asString(descriptor['text']) ?? '',
    asString(descriptor['value']) ?? '',
    asString(descriptor['href']) ?? '',
    asString(descriptor['formAction']) ?? '',
    asString(descriptor['formText']) ?? '',
  ].join(' ');
}

function descriptorRole(value: unknown): string | undefined {
  const role = asString(asRecord(value)['role']);
  return role !== undefined && role.length > 0 ? role : undefined;
}

/**
 * The anchor facts the inspector reports, for the plain-navigation exemption.
 *
 * This path has no element to read, so the descriptor carries what the browser already computed
 * (`isAnchor`, `hasClickHandler`, `insideForm`) and the href it already exposes.
 *
 * Handed over only when the descriptor declares ALL THREE facts. A descriptor from a version that
 * predates them describes a link whose anchor-ness and handler nobody checked, and treating that
 * silence as "plain" would exempt a wired-up link on the strength of what nobody asked. Unknown
 * refuses; proven narrows.
 */
function descriptorLinkAttributes(value: unknown): LinkAttributes {
  const descriptor = asRecord(value);
  const declared =
    'boolean' === typeof descriptor['isAnchor'] &&
    'boolean' === typeof descriptor['hasClickHandler'] &&
    'boolean' === typeof descriptor['insideForm'];
  if (!declared) return {};
  const href = asString(descriptor['href']);
  return {
    ...(href !== undefined ? { href } : {}),
    isAnchor: true === descriptor['isAnchor'],
    hasClickHandler: true === descriptor['hasClickHandler'],
    insideForm: true === descriptor['insideForm'],
  };
}

/**
 * `navigation` is false at a DRAG END. Dropping a row onto a link is not navigation, and a drop
 * target is exactly what a link looks like, so that end is classified on its text alone.
 */
function isDestructiveDescriptor(value: unknown, navigation = true): boolean {
  return classifyActionText(
    descriptorText(value),
    descriptorRole(value),
    navigation ? descriptorLinkAttributes(value) : {},
  );
}

export function assertNotDestructive(
  action: ActionType,
  innerArgs: Record<string, unknown>,
  inspected: unknown,
): void {
  if (action !== ActionType.CLICK && action !== ActionType.DBLCLICK) return;
  if (true === innerArgs[DANGEROUS_ACTION_CONFIRM_ARG]) return;
  if (!isDestructiveDescriptor(inspected)) return;
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
  if (true === innerArgs[DANGEROUS_ACTION_CONFIRM_ARG]) return;
  if (!isDestructiveDescriptor(from, false) && !isDestructiveDescriptor(to, false)) return;
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
  if (true === innerArgs[NATIVE_INPUT_ARG]) throw new Error(NATIVE_INPUT_UNSUPPORTED);
}
