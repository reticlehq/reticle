/**
 * Form fields: the one thing a form does, which nothing in the SDK could see.
 *
 * `value` is in the DOM observer's attribute allowlist and that observer runs with
 * `attributeOldValue: true`. It has never once fired for a React input, because React and every
 * controlled component set the PROPERTY, and `MutationObserver` watches attributes. Nothing
 * subscribed to `input` or `change`, so a field's value was readable ON DEMAND and there was no
 * EVENT to cite: "this field held its value across the re-render" had nothing to point at, and a
 * write the app silently dropped left no trace at all.
 *
 * Redaction is not a feature here, it is the precondition for shipping it. A form is where somebody
 * types their password, their card number and their address, and an observer that records those is
 * worse than no observer. So a value rides out only when the field is not a password, its name is
 * not sensitive under the policy in force, and its autocomplete hint does not say payment. The
 * LENGTH always rides out, because "it was wiped" is the assertion this exists for and a length
 * says it while carrying nobody's data.
 */
import { readTestId } from '@/dom/addressing/testid-attr.js';
import {
  DEFAULT_TESTID_ATTR,
  EventType,
  FieldChangeField,
  FieldChangeKind,
  isSensitiveKey,
} from '@reticlehq/core';
import { getAccessibleName } from '@/dom/a11y.js';
import type { Emit, Teardown } from './types.js';

/** Long enough for a title or a sentence, short enough that a pasted document is not the ledger. */
const MAX_VALUE_LEN = 160;

/**
 * One event per burst of keystrokes.
 *
 * `input` fires per keystroke: a typed sentence would arrive forty times and drown every other
 * channel in the window a verdict is taken over. The trailing value is the same information at a
 * fortieth of the cost. `change` is a commit and is never delayed.
 */
const BURST_MS = 150;

/** Fields whose CONTENT is never recorded, whatever they are named. */
const PAYMENT_AUTOCOMPLETE = /^(cc-|current-password|new-password)/i;

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** A checkbox or radio. Their HTML `value` does not move when they toggle; `checked` does. */
const CHECKBOX_TYPE = 'checkbox';
const RADIO_TYPE = 'radio';

/**
 * Value and, for a checkbox or radio, `checked`, read off the element.
 *
 * Captured before an action is dispatched and again after it settles, so the two can be compared
 * once React has restored a controlled property.
 */
export interface FieldReading {
  value: string;
  checked?: boolean;
}

/** The emitter `installField` registered, so an action can publish a settled read into the same stream. */
let settledEmit: Emit | undefined;

function isField(target: EventTarget | null): target is Field {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function isCheckable(element: Field): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement &&
    (CHECKBOX_TYPE === element.type || RADIO_TYPE === element.type)
  );
}

function readingOf(element: Field): FieldReading {
  if (isCheckable(element)) return { value: element.value, checked: element.checked };
  return { value: element.value };
}

function readingMoved(before: FieldReading, after: FieldReading): boolean {
  if (before.checked !== undefined || after.checked !== undefined) {
    return before.checked !== after.checked;
  }
  return before.value !== after.value;
}

function clip(value: string): string {
  return value.length > MAX_VALUE_LEN ? `${value.slice(0, MAX_VALUE_LEN)}…` : value;
}

/**
 * What to call this field in a verdict.
 *
 * `data-testid` first because that is what an assertion names; then the form `name`, then the
 * accessible name, which is what a person reading the page would call it.
 */
function fieldName(element: Field): string {
  const testid = readTestId(element);
  if (null !== testid && testid.length > 0) return testid;
  if (element.name.length > 0) return element.name;
  const accessible = getAccessibleName(element);
  if (accessible.length > 0) return accessible;
  const id = element.getAttribute('id');
  return null !== id && id.length > 0 ? id : element.tagName.toLowerCase();
}

/** Is this field's CONTENT somebody's secret? Three independent reasons, any one is enough. */
function isSecret(element: Field): boolean {
  if (element instanceof HTMLInputElement && 'password' === element.type) return true;
  const hint = element.getAttribute('autocomplete');
  if (null !== hint && PAYMENT_AUTOCOMPLETE.test(hint)) return true;
  for (const key of [
    element.name,
    readTestId(element),
    element.getAttribute(DEFAULT_TESTID_ATTR),
    element.getAttribute('id'),
  ]) {
    if (null !== key && key.length > 0 && isSensitiveKey(key)) return true;
  }
  return false;
}

/**
 * The wire payload for one field reading.
 *
 * A settled read also carries the pre-action reading. Checkable fields carry `checked` rather than
 * a previous string: their HTML value does not move, and comparing `"on"` to `"on"` would hide a
 * toggle. Secrets omit both strings.
 */
function fieldPayload(
  element: Field,
  kind: FieldChangeKind,
  after: FieldReading,
  before?: FieldReading,
): Record<string, unknown> {
  const secret = isSecret(element);
  const payload: Record<string, unknown> = {
    [FieldChangeField.FIELD]: fieldName(element),
    [FieldChangeField.KIND]: kind,
    // Always present, and NOT derived from the clipped value: a cap must never read as a wipe.
    [FieldChangeField.LENGTH]: after.value.length,
  };
  if (after.checked !== undefined) payload[FieldChangeField.CHECKED] = after.checked;
  if (before?.checked !== undefined) payload[FieldChangeField.PREVIOUS_CHECKED] = before.checked;
  if (secret) {
    payload[FieldChangeField.REDACTED] = true;
    return payload;
  }
  payload[FieldChangeField.VALUE] = clip(after.value);
  if (before !== undefined && before.checked === undefined) {
    payload[FieldChangeField.PREVIOUS] = clip(before.value);
  }
  return payload;
}

/**
 * The field's value and `checked` before an action is dispatched.
 *
 * Undefined when `el` is not a field. The action reads this first and passes it back to
 * `publishSettledField` after settle, which is the frame after the app's handlers ran.
 */
export function readActedField(el: Element): FieldReading | undefined {
  if (!isField(el)) return undefined;
  return readingOf(el);
}

/**
 * Publish a settled field read into the event stream, when one differs from `before`.
 *
 * No-op until `installField` is running, when the element is gone, or when the settled reading
 * matches the pre-action one — a controlled input React restored did not render. A secret text
 * field is not published either: the values cannot ride the wire, so the event could not be
 * compared and would only look like a change.
 */
export function publishSettledField(el: Element, before: FieldReading | undefined): void {
  const emit = settledEmit;
  if (emit === undefined || before === undefined || !isField(el) || !el.isConnected) return;
  if (isSecret(el) && before.checked === undefined) return;
  const after = readingOf(el);
  if (!readingMoved(before, after)) return;
  emit(EventType.FIELD_CHANGE, fieldPayload(el, FieldChangeKind.SETTLED, after, before));
}

/**
 * Watch every field on the page for a value that moves. Emits FIELD_CHANGE. Reversible, and a
 * teardown cancels any burst still waiting — an event emitted after `disconnect()` is the SDK
 * talking about a page it was told to leave.
 */
export function installField(emit: Emit): Teardown {
  const ac = new AbortController();
  const { signal } = ac;
  const previousEmit = settledEmit;
  settledEmit = emit;
  /** One pending burst per field, so two fields being typed into never coalesce into one event. */
  const pending = new Map<Field, ReturnType<typeof setTimeout>>();

  const report = (element: Field, kind: FieldChangeKind): void => {
    emit(EventType.FIELD_CHANGE, fieldPayload(element, kind, readingOf(element)));
  };

  const clear = (element: Field): void => {
    const timer = pending.get(element);
    if (timer !== undefined) clearTimeout(timer);
    pending.delete(element);
  };

  const onInput = (event: Event): void => {
    const element = event.target;
    if (!isField(element)) return;
    clear(element);
    pending.set(
      element,
      setTimeout(() => {
        pending.delete(element);
        report(element, FieldChangeKind.INPUT);
      }, BURST_MS),
    );
  };

  const onChange = (event: Event): void => {
    const element = event.target;
    if (!isField(element)) return;
    // A commit supersedes the burst it ends: reporting both would double-count one edit.
    clear(element);
    report(element, FieldChangeKind.CHANGE);
  };

  document.addEventListener('input', onInput, { signal, capture: true });
  document.addEventListener('change', onChange, { signal, capture: true });
  return () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    if (settledEmit === emit) settledEmit = previousEmit;
    ac.abort();
  };
}
