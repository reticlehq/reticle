import { captureCheckedSetter, captureValueSetter } from '../patching/capture-method.js';
import { valuePrototypeOf } from '../dom/realm.js';

/**
 * Writing a value into a field, and the two preconditions that make it honest.
 *
 * Lifted out of actions.ts when that file hit the 600-line cap. It is a cohesive unit: every export
 * here exists so that a value write either lands as a real user's edit would, or is refused with a
 * reason — never forced through while reporting success.
 */

/**
 * Set a value on a controlled input the way React expects (native setter + input event).
 * Returns the `input` event's dispatchEvent result (defaultPrevented of the primary event).
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  // Realm-aware: a controlled input inside a same-origin frame has its own prototype.
  const proto = valuePrototypeOf(el);
  const setter = proto === undefined ? undefined : captureValueSetter(proto);
  if (setter !== undefined) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  const notPrevented = el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return !notPrevented;
}

/**
 * Set checked on a controlled checkbox/radio the way React expects (native setter + input & change events).
 * Returns true if defaultPrevented was triggered by any listener, false otherwise.
 */
export function setNativeChecked(el: HTMLInputElement, checked: boolean): boolean {
  // Realm-aware: a controlled input inside a same-origin frame has its own prototype.
  const proto = valuePrototypeOf(el);
  const setter = proto === undefined ? undefined : captureCheckedSetter(proto);
  if (setter !== undefined) {
    setter.call(el, checked);
  } else {
    el.checked = checked;
  }
  const notPrevented = el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return !notPrevented;
}

/**
 * Refuse to write to a field a person could not edit.
 *
 * `readonly` and `disabled` block USER input, not scripted assignment, so the prototype value setter
 * writes straight through both. Measured: filling a readonly input reported `ok:true` and
 * `valueChanged:true` with nothing in the effect block marking it read-only. That leaves the app in a
 * state no user could reach, and every conclusion drawn from what follows is about software nobody
 * can operate — the same reason the click path reports `occluded`, and the same choice Playwright
 * makes when it refuses to fill a non-editable element.
 */
/**
 * A rich-text target is UNSUPPORTED, not a mistake by the caller.
 *
 * Every rich-text editor (TipTap, Quill, ProseMirror, Slate, Lexical) is `[contenteditable]`, and
 * these actions handle only input/textarea. `cannot fill a <div>` reads as "you picked the wrong
 * element" and sends the reader hunting for a better selector that does not exist. Support is not
 * faked: assigning textContent would update the DOM while the editor's own model kept the old value,
 * so the tool would report success for content the app will never submit.
 */
export function assertNotRichText(el: HTMLElement, action: string): void {
  // The ATTRIBUTE, not `isContentEditable`: jsdom does not implement the property, so a test would
  // pass against a guard that never fires in the environment the unit suite runs in.
  const flag = el.getAttribute('contenteditable');
  if (el.isContentEditable || (flag !== null && flag !== 'false')) {
    throw new Error(
      `cannot ${action} a contenteditable element — rich-text editors keep their own document model, ` +
        'so writing to the DOM here would look right and submit the old content. This surface is not supported yet.',
    );
  }
}

export function assertEditable(el: HTMLInputElement | HTMLTextAreaElement, action: string): void {
  if (el.disabled) {
    throw new Error(
      `cannot ${action} a disabled <${el.tagName.toLowerCase()}> — a user could not edit it, so forcing the value would put the app in a state nobody can reach`,
    );
  }
  if (el.readOnly) {
    throw new Error(
      `cannot ${action} a readonly <${el.tagName.toLowerCase()}> — a user could not edit it, so forcing the value would put the app in a state nobody can reach`,
    );
  }
}
