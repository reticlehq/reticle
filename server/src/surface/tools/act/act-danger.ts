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
 * This path has no element to read, so the descriptor carries what the browser already computed and
 * the href it exposes. Only a POSITIVE handler reading travels: the browser can prove a handler
 * exists, never that one is absent, so a `false` here would be an absence nobody observed. The
 * absence the exemption needs comes from the CDP session instead, as the guard's own argument.
 *
 * `isAnchor` and `insideForm` are required because the browser always computes them; without them the
 * descriptor is from a version that did not, and its silence must not be read as "plain".
 */
function descriptorLinkAttributes(value: unknown): LinkAttributes {
  const descriptor = asRecord(value);
  const declared =
    'boolean' === typeof descriptor['isAnchor'] && 'boolean' === typeof descriptor['insideForm'];
  if (!declared) return {};
  const href = asString(descriptor['href']);
  return {
    ...(href !== undefined ? { href } : {}),
    isAnchor: true === descriptor['isAnchor'],
    // Carried only when true. A `false` is dropped, so the predicate refuses rather than exempting
    // on a reading the page was never able to take.
    ...(true === descriptor['hasClickHandler'] ? { hasClickHandler: true } : {}),
    insideForm: true === descriptor['insideForm'],
    // Only a positive reading refuses, so a descriptor without the marker is unaffected.
    ...(true === descriptor['nonGetMarker'] ? { nonGetMarker: true } : {}),
  };
}

/**
 * `navigation` is false at a DRAG END. Dropping a row onto a link is not navigation, and a drop
 * target is exactly what a link looks like, so that end is classified on its text alone.
 *
 * `clickListeners` is the CDP reading for this element when a driver could take one: `true` a real
 * listener was found, `false` a proven handlerless element, `undefined` nothing could answer. Only
 * the definite `false` narrows. It overwrites the page's own reading because the page can prove a
 * handler PRESENT and never absent, and this is the one source that can prove absence.
 */
function isDestructiveDescriptor(
  value: unknown,
  navigation = true,
  clickListeners?: boolean,
): boolean {
  if (!navigation) return classifyActionText(descriptorText(value), descriptorRole(value), {});
  const attrs = descriptorLinkAttributes(value);
  // A handler the PAGE proved always blocks, and the CDP reading can never undo that. Otherwise the
  // CDP reading decides, and only its definite `false` narrows.
  const effective = true === attrs.hasClickHandler ? true : clickListeners;
  return classifyActionText(
    descriptorText(value),
    descriptorRole(value),
    effective === undefined ? attrs : { ...attrs, hasClickHandler: effective },
  );
}

/**
 * Whether a handlerless reading could EXEMPT this descriptor, which is the only reason to spend a CDP
 * round-trip on it.
 *
 * True when the descriptor describes a plain-navigation candidate that is currently blocked only for
 * lack of a proven-handlerless reading: a real anchor, no page-proved handler, not inside a form, and
 * a text/address that the destructive pattern flags. A button, a form control, or a link the page
 * wired up is refused for reasons a handler reading cannot touch, so a caller skips the round-trips.
 */
export function couldListenerReadingExempt(value: unknown): boolean {
  const attrs = descriptorLinkAttributes(value);
  if (true === attrs.hasClickHandler) return false;
  return !classifyActionText(descriptorText(value), descriptorRole(value), {
    ...attrs,
    hasClickHandler: false,
  });
}

export function assertNotDestructive(
  action: ActionType,
  innerArgs: Record<string, unknown>,
  inspected: unknown,
  clickListeners?: boolean,
): void {
  if (action !== ActionType.CLICK && action !== ActionType.DBLCLICK) return;
  if (true === innerArgs[DANGEROUS_ACTION_CONFIRM_ARG]) return;
  if (!isDestructiveDescriptor(inspected, true, clickListeners)) return;
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
