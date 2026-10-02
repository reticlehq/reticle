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

import { classifyActionText, type LinkAttributes } from '@reticlehq/core';
import { getAccessibleName, getRole } from '@/dom/a11y.js';
import { type ActionTarget, isHtmlElement } from '@/dom/realm.js';
import { elementHandlesClick } from '@/registry/stores/adapters.js';

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

/**
 * The element facts the pattern cannot read for itself.
 *
 * A plain anchor is the one control whose label and address are not evidence of what it does: its
 * href is a URL, and URLs carry the pattern's words (`/billing/payment`). Whether it is plain is a
 * question about the ELEMENT — is it an anchor, does anything handle a click, does it belong to a
 * form — so it is answered here, where the element is. The `href` is included only when the element
 * HAS the attribute, so an anchor with no `href` is not mistaken for one pointing at empty.
 *
 * `isAnchor` is a separate fact from the role on purpose: `getRole` answers `link` for anything an
 * author tagged that way, and `<div role="link" onclick="…">Delete account</div>` is not an anchor.
 */
function linkAttributes(el: ActionTarget): LinkAttributes {
  const href = el.getAttribute('href');
  return {
    ...(href !== null ? { href } : {}),
    isAnchor: el instanceof HTMLAnchorElement,
    hasClickHandler: true === elementHandlesClick(el),
    insideForm: el.closest('form') !== null,
  };
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
 * Does driving this element need `confirmDangerous`?
 *
 * The element decides, not its text alone: a `<a href>` with no handler and no form moves by GET
 * and changes nothing, so the words in its label and its address are not evidence of a destructive
 * act. The controls that CAN act — anything that is not an anchor, a link with a handler, an anchor
 * inside a form, a non-http href — keep the text-only answer.
 *
 * `navigationAllowed` is how a DRAG end opts out. Dropping a row onto a link is not navigation, and
 * a link is exactly what a drop target looks like, so that path asks for the text-only answer and
 * cannot be exempted by the anchor's shape.
 */
export function requiresDangerousConfirmation(el: ActionTarget, navigationAllowed = true): boolean {
  const attrs = navigationAllowed ? linkAttributes(el) : { isAnchor: false };
  return classifyActionText(dangerousActionContext(el), getRole(el), attrs);
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
