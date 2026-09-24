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
import { EventType, isSensitiveKey } from '@reticlehq/core';
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

function isField(target: EventTarget | null): target is Field {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * What to call this field in a verdict.
 *
 * `data-testid` first because that is what an assertion names; then the form `name`, then the
 * accessible name, which is what a person reading the page would call it.
 */
function fieldName(element: Field): string {
  const testid = element.getAttribute('data-testid');
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
    element.getAttribute('data-testid'),
    element.getAttribute('id'),
  ]) {
    if (null !== key && key.length > 0 && isSensitiveKey(key)) return true;
  }
  return false;
}

/**
 * Watch every field on the page for a value that moves. Emits FIELD_CHANGE. Reversible, and a
 * teardown cancels any burst still waiting — an event emitted after `disconnect()` is the SDK
 * talking about a page it was told to leave.
 */
export function installField(emit: Emit): Teardown {
  const ac = new AbortController();
  const { signal } = ac;
  /** One pending burst per field, so two fields being typed into never coalesce into one event. */
  const pending = new Map<Field, ReturnType<typeof setTimeout>>();

  const report = (element: Field, kind: 'input' | 'change'): void => {
    const value = element.value;
    const secret = isSecret(element);
    emit(EventType.FIELD_CHANGE, {
      field: fieldName(element),
      kind,
      // Always present, and NOT derived from the clipped value: a cap must never read as a wipe.
      length: value.length,
      ...(secret
        ? { redacted: true }
        : { value: value.length > MAX_VALUE_LEN ? `${value.slice(0, MAX_VALUE_LEN)}…` : value }),
    });
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
        report(element, 'input');
      }, BURST_MS),
    );
  };

  const onChange = (event: Event): void => {
    const element = event.target;
    if (!isField(element)) return;
    // A commit supersedes the burst it ends: reporting both would double-count one edit.
    clear(element);
    report(element, 'change');
  };

  document.addEventListener('input', onInput, { signal, capture: true });
  document.addEventListener('change', onChange, { signal, capture: true });
  return () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    ac.abort();
  };
}
