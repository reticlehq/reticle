import { captureValueSetter } from '@/patching/capture-method.js';
import { type ActionTarget, isHtmlElement, valuePrototypeOf } from '@/dom/realm.js';

/**
 * Writing a value into a field, and the two preconditions that make it honest.
 *
 * Every export here exists so that a value write either lands as a real user's edit would, or is
 * refused with a reason — never forced through while reporting success.
 */

/**
 * Set a value on a controlled input the way React expects (native setter + input event).
 * Returns the `input` event's dispatchEvent result (defaultPrevented of the primary event).
 */
/** The autocomplete tokens WebKit offers saved passwords for. */
const PASSWORD_AUTOCOMPLETE = /\b(current|new)-password\b/;
/** Blink and Gecko never raise WebKit's panel; Blink still spells its frozen `AppleWebKit/537.36`. */
const NOT_WEBKIT = /Chrome|Chromium|Edg\/|Firefox|Gecko\//;

/**
 * A fill that must not focus its field: a password field in WebKit, where focus raises the system
 * saved-password panel (a signed WKWebView app, Safari). The value setter and the input/change
 * events are what React, Vue and a plain form read, so the app still hears the value; an editor that
 * commits only on blur would not, which is why this is limited to password fields.
 */
export function isAutofillSafeTarget(el: Element, ua: string = navigator.userAgent): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  const password =
    'password' === el.type.toLowerCase() ||
    PASSWORD_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '');
  if (!password || NOT_WEBKIT.test(ua)) return false;
  // Real WebKit reports 600+; Blink froze 537.36, and so do test DOMs that borrow its string.
  return 600 <= Number(/AppleWebKit\/(\d+)/.exec(ua)?.[1] ?? 0);
}

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
 * TipTap, Quill, ProseMirror, Slate, and Lexical set `contenteditable`. Monaco and CodeMirror do
 * not: they are a `role="textbox"` with the document in the EditContext API. Both used to read as
 * "you picked the wrong element". One sentence covers both, and it stays short because this file
 * is on the SDK's first load.
 *
 * The attribute, not only `isContentEditable`: jsdom does not implement the property, so a test
 * would pass against a guard that never fires in the environment the unit suite runs in.
 */
function isRichText(el: ActionTarget): boolean {
  const flag = el.getAttribute('contenteditable');
  if ((isHtmlElement(el) && el.isContentEditable) || (null !== flag && 'false' !== flag))
    return true;
  if ('textbox' === el.getAttribute('role')) return true;
  if (!('editContext' in el)) return false;
  const surface = el as HTMLElement & { editContext?: object | null };
  return null !== surface.editContext && undefined !== surface.editContext;
}

export function assertNotRichText(el: ActionTarget, action: string): void {
  if (!isRichText(el)) return;
  throw new Error(
    `cannot ${action} a contenteditable or EditContext editor; use press or an input`,
  );
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
