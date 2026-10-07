/**
 * WHICH TEXT decides whether an action is destructive.
 *
 * A different question from how an action is performed: this file decides what the control SAYS, and
 * the answer can be wrong in both directions at once — blocking a textarea that contains "pressure
 * drop", and not blocking Enter in a form whose submit button says "Delete account". One defect,
 * classifying the wrong text.
 *
 * The pattern itself lives in core (`isDangerousActionText`) and is deliberately narrow. This file
 * only chooses what to hand it.
 */

import { isDangerousActionText } from '@reticlehq/core';
import { getAccessibleName } from '@/dom/a11y.js';
import { type ActionTarget, isHtmlElement } from '@/dom/realm.js';

/**
 * Input types whose `value` IS the visible label rather than data the user put there.
 *
 * `<input type="submit" value="Delete account">` is a button that happens to be an input, and its
 * value is the word on it. Everything else holds what somebody typed.
 */
const LABEL_VALUED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'submit',
  'button',
  'reset',
  'image',
]);

/**
 * Does this control's own text belong to the USER rather than to the app?
 *
 * A button's text is its label, so classifying it is the whole point. A text entry's content is
 * DATA, and classifying that blocks a user for typing the words "pressure drop": `\bdrop\b` is in the
 * destructive-label pattern and matches the sentence just filled in, not any label on the page. The
 * way past such a block is `confirmDangerous: true`, which is how a safety guard becomes decorative.
 */
function holdsUserText(el: ActionTarget): boolean {
  if (isHtmlElement(el) && el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !LABEL_VALUED_INPUT_TYPES.has(el.type.toLowerCase());
  return false;
}

export function dangerousActionContext(el: ActionTarget): string {
  const form = el.closest('form');
  // The label surfaces only, when the content is the user's own. The accessible NAME still counts:
  // that is the prompt beside the field, and "Type DELETE to remove this account" is exactly the
  // control this guard exists for.
  const ownText = holdsUserText(el)
    ? ['', '']
    : [el.textContent ?? '', el.getAttribute('value') ?? ''];
  return [
    getAccessibleName(el),
    ...ownText,
    el.getAttribute('title') ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('href') ?? '',
    form?.getAttribute('action') ?? '',
  ].join(' ');
}

/**
 * What pressing Enter in this field would actually trigger.
 *
 * Enter inside a form submits it, so the control being driven is the SUBMIT BUTTON, not the field
 * the cursor is in. The guard read only the field, which made it both wrong ways round: it blocked a
 * textarea containing the word "drop", and it did not block Enter in a form whose submit button says
 * "Delete account". A button with no `type` is a submit button, which is why it is matched here.
 */
const SUBMIT_CONTROL_SELECTOR =
  'button[type="submit"], input[type="submit"], button:not([type]):not([type=""])';

export function submitControlFor(el: ActionTarget): HTMLElement | null {
  const found = el.closest('form')?.querySelector(SUBMIT_CONTROL_SELECTOR);
  return found instanceof HTMLElement ? found : null;
}

export function requiresDangerousConfirmation(text: string, role?: string): boolean {
  return isDangerousActionText(text, role);
}

/**
 * A same-origin `<a href>` with no click handler is a plain GET navigation: clicking it cannot
 * destroy anything or move money, so the destructive-action guard has no business with it.
 *
 * The link's `href` still feeds `dangerousActionContext` — `<a href="/billing/payments">` trips
 * `\bpayment\b` through its URL even when its text says "Orders & invoices" — but the element can
 * only navigate, so the guard must not block it. A link with an `onclick` handler can do anything,
 * and one with `download` saves a file rather than navigating, so both keep today's behaviour. A
 * `javascript:`/`mailto:`/off-origin href resolves to a different origin and is likewise not exempt.
 */
export function isPlainNavigationLink(el: ActionTarget): boolean {
  if (!(el instanceof HTMLAnchorElement)) return false;
  const href = el.getAttribute('href');
  if (null === href || '' === href) return false;
  if (el.hasAttribute('onclick') || 'function' === typeof el.onclick) return false;
  if (el.hasAttribute('download')) return false;
  try {
    const doc = el.ownerDocument;
    const view = doc.defaultView;
    return new URL(href, doc.baseURI).origin === view?.location.origin;
  } catch {
    return false;
  }
}
