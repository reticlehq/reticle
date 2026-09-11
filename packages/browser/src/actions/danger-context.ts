/**
 * WHICH TEXT decides whether an action is destructive.
 *
 * Split out of actions.ts, which sits at the size backstop, and split here because it is a different
 * question from how an action is performed: this file decides what the control SAYS, and the answer
 * has been wrong in both directions at once. It blocked a CFD engineer for typing "pressure drop"
 * into a textarea, and it did not block Enter in a form whose submit button said "Delete account" —
 * one defect, classifying the wrong text.
 *
 * The pattern itself lives in core (`isDangerousActionText`) and is deliberately narrow. This file
 * only chooses what to hand it.
 */

import { isDangerousActionText } from '@reticlehq/core';
import { getAccessibleName } from '../dom/a11y.js';
import { isTextArea } from '../dom/realm.js';

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
 * DATA, and classifying that is how the guard came to block a CFD engineer for typing the words
 * "pressure drop" — `\bdrop\b` is in the destructive-label pattern, and it matched the sentence the
 * agent had just filled in, not any label on the page. Reported from the field; the agent got past
 * it with `confirmDangerous: true`, which is precisely how a safety guard becomes decorative.
 */
function holdsUserText(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !LABEL_VALUED_INPUT_TYPES.has(el.type.toLowerCase());
  return false;
}

export function dangerousActionContext(el: HTMLElement): string {
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

export function submitControlFor(el: HTMLElement): HTMLElement | null {
  // Except in a textarea, where Enter inserts a NEWLINE and submits nothing. Judging it by the
  // form's submit button blocks the one keystroke on the page that does the least: the field is
  // exempted from its own text above, and then the button next to it supplies the danger anyway.
  // That is the reported false positive in its second shape -- Enter in a notes box, refused beside
  // a submit button a click on would have been judged the same way and allowed.
  if (isTextArea(el)) return null;
  const found = el.closest('form')?.querySelector(SUBMIT_CONTROL_SELECTOR);
  return found instanceof HTMLElement ? found : null;
}

export function requiresDangerousConfirmation(text: string, role?: string): boolean {
  return isDangerousActionText(text, role);
}
