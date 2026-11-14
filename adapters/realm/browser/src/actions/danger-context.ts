/**
 * WHICH TEXT decides whether an action is destructive.
 *
 * A different question from how an action is performed: this file decides what the control SAYS, and
 * the answer can be wrong in both directions at once — blocking a textarea that contains "pressure
 * drop", and not blocking Enter in a form whose submit button says "Delete account". One defect,
 * classifying the wrong text.
 *
 * One more reading of the same defect, from half B of #894. A control whose content is user
 * data — a media clip tile showing a filename that contains "remove", or a "Create preview"
 * button whose name carries that filename — was blocked as destructive. A filename-like token
 * never reads as an action verb, so filename tokens are stripped before the text is classified.
 *
 * The pattern itself lives in core (`isDangerousActionText`) and is deliberately narrow. This file
 * only chooses what to hand it.
 */

import {
  OutwardAction,
  dangerousActionWord,
  dangerousNavigationReason,
  destructiveActionWord,
  isInertHref,
  isPaymentField,
  outwardActionOf,
  outwardRefusal,
  withoutFilenameTokens,
} from '@reticlehq/core';
import { getAccessibleName, getRole } from '@/dom/a11y.js';
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
  if (isHtmlElement(el) && el.isContentEditable) {
    return true;
  }
  if (el instanceof HTMLTextAreaElement) {
    return true;
  }
  if (el instanceof HTMLInputElement) {
    return !LABEL_VALUED_INPUT_TYPES.has(el.type.toLowerCase());
  }
  return false;
}

const ANCHOR_TAG = 'A';

/**
 * Where a real link goes, when it goes somewhere. Its text is CONTENT the app shows (an issue titled
 * "Checkout pay fails" was blocked as a payment); following a link is a navigation, so its target is
 * what can be destructive (`/account/delete`), not the words on it.
 */
function navigatingHref(el: ActionTarget): string | undefined {
  // By tag, not `instanceof`: a link inside a same-origin iframe has that frame's constructors.
  if (ANCHOR_TAG !== el.tagName) {
    return undefined;
  }
  const href = el.getAttribute('href');
  return null === href || isInertHref(href) ? undefined : href;
}

/** Where a piece of classified text came from. A refusal names it, so the agent knows what to fix. */
export const DangerSource = {
  NAME: 'name',
  OWN_TEXT: 'own text',
  TITLE: 'title',
  ARIA_LABEL: 'aria-label',
  HREF: 'href',
  FORM_ACTION: 'form action',
  /** A phrase ("close account") that only matches once two of the surfaces above are joined. */
  JOINED: 'joined text',
} as const;
export type DangerSource = (typeof DangerSource)[keyof typeof DangerSource];

/** Every surface the guard reads, each with where it came from. */
function labelledSurfaces(el: ActionTarget): readonly (readonly [DangerSource, string])[] {
  const form = el.closest('form');
  // The label surfaces only, when the content is the user's own. The accessible NAME still counts:
  // that is the prompt beside the field, and "Type DELETE to remove this account" is exactly the
  // control this guard exists for.
  const ownText = holdsUserText(el)
    ? ['', '']
    : [el.textContent ?? '', el.getAttribute('value') ?? ''];
  return [
    [DangerSource.NAME, withoutFilenameTokens(getAccessibleName(el))],
    [DangerSource.OWN_TEXT, withoutFilenameTokens(ownText.join(' '))],
    [DangerSource.TITLE, withoutFilenameTokens(el.getAttribute('title') ?? '')],
    [DangerSource.ARIA_LABEL, withoutFilenameTokens(el.getAttribute('aria-label') ?? '')],
    [DangerSource.HREF, el.getAttribute('href') ?? ''],
    [DangerSource.FORM_ACTION, form?.getAttribute('action') ?? ''],
  ];
}

export function dangerousActionContext(el: ActionTarget): string {
  const href = navigatingHref(el);
  if (href !== undefined) {
    return href;
  }
  return labelledSurfaces(el)
    .map(([, text]) => text)
    .join(' ');
}

/**
 * Does this control only OPEN something — a menu, a listbox, a dialog, a disclosure? Then pressing it
 * moves no money, whatever its name says. "Actions for Payment successful" opens a row menu; a
 * "Model" button opens a picker. A submit button is never one: it submits, whatever else it says.
 */
function opensPopupOnly(el: ActionTarget): boolean {
  if (null !== el.closest('form') && el.matches(SUBMIT_CONTROL_SELECTOR)) {
    return false;
  }
  const hasPopup = el.getAttribute('aria-haspopup');
  if (null !== hasPopup && 'false' !== hasPopup.trim().toLowerCase()) {
    return true;
  }
  return el.hasAttribute('aria-expanded');
}

/** What the guard read on one control: the control, the word, and where the word was. */
export interface DangerCause {
  readonly role: string;
  readonly name: string;
  readonly word: string;
  readonly source: DangerSource;
}

/**
 * Why acting on this control needs `confirmDangerous`; undefined when it does not.
 *
 * A link that navigates is judged by where it goes. Every other control is judged by the text it
 * shows, one surface at a time so the refusal can say which one matched.
 */
export function dangerCause(el: ActionTarget): DangerCause | undefined {
  const role = getRole(el);
  const control = { role, name: getAccessibleName(el) };
  const href = navigatingHref(el);
  if (href !== undefined) {
    const reason = dangerousNavigationReason(href);
    return reason === undefined
      ? undefined
      : { ...control, word: reason, source: DangerSource.HREF };
  }
  const wordIn = opensPopupOnly(el) ? destructiveActionWord : dangerousActionWord;
  const surfaces = labelledSurfaces(el);
  for (const [source, text] of surfaces) {
    const word = wordIn(text, role);
    if (word !== undefined) {
      return { ...control, word, source };
    }
  }
  const joined = wordIn(surfaces.map(([, text]) => text).join(' '), role);
  return joined === undefined
    ? undefined
    : { ...control, word: joined, source: DangerSource.JOINED };
}

/** One control in a refusal: `button "Delete account" ("delete" in its name)`. */
function describeDangerCause(cause: DangerCause): string {
  const control = '' === cause.name ? cause.role : `${cause.role} "${cause.name}"`;
  return `${control} ("${cause.word}" in its ${cause.source})`;
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
  // Realm-aware: isHtmlElement resolves constructors from the element's own
  // document, so a submit button inside a same-origin iframe is found. The
  // ambient instanceof would miss it and skip the destructive-action guard.
  return isHtmlElement(found) ? found : null;
}

/** Why a refusal names a control: it is the target, or what the action also presses or drops on. */
const DangerRole = {
  TARGET: '',
  SUBMITTER: 'the submit button Enter presses: ',
  DROP_TARGET: 'the drop target: ',
} as const;
type DangerRole = (typeof DangerRole)[keyof typeof DangerRole];

/** One control's part of a refusal, or undefined when that control is not destructive. */
function describedCause(el: ActionTarget | null, which: DangerRole): string | undefined {
  const cause = null === el ? undefined : dangerCause(el);
  return cause === undefined ? undefined : `${which}${describeDangerCause(cause)}`;
}

/**
 * What a destructive-action refusal names: each control that needs `confirmDangerous`, with its
 * word and where the word was. Undefined when no control does, and the action may run.
 */
export function dangerCauses(
  el: ActionTarget,
  submitter: ActionTarget | null,
  dropTarget: ActionTarget | null,
): string | undefined {
  const causes = [
    describedCause(el, DangerRole.TARGET),
    describedCause(submitter, DangerRole.SUBMITTER),
    describedCause(dropTarget, DangerRole.DROP_TARGET),
  ].filter((cause): cause is string => cause !== undefined);
  return 0 === causes.length ? undefined : causes.join('; ');
}

/** The outward actions the Harness command being run may take; undefined: not gated. */
let outwardAllowed: readonly string[] | undefined;

/** Set around each command from its `outward` field: only a Harness command a model chose has one. */
export function setOutwardPolicy(allowed: readonly string[] | undefined): void {
  outwardAllowed = allowed;
}

/**
 * Refuse a control that would invite, send, share, delete, pay… unless the journey asked for that
 * action. The Harness pressed Invite in a customer's workspace when its journey said not to.
 */
export function assertOutwardAllowed(targets: readonly (ActionTarget | null)[]): void {
  if (outwardAllowed === undefined) {
    return;
  }
  for (const el of targets) {
    if (null === el) {
      continue;
    }
    const kind = outwardActionOf(dangerousActionContext(el), getRole(el));
    if (kind !== undefined && !outwardAllowed.includes(kind)) {
      throw new Error(outwardRefusal(kind));
    }
  }
}

/**
 * Refuse to type card or bank details unless the journey asked to pay. With a button's words no
 * longer read as paying ("Start free trial"), this and a link to a payment provider are the boundary.
 */
export function assertPaymentEntryAllowed(el: ActionTarget): void {
  if (outwardAllowed === undefined || outwardAllowed.includes(OutwardAction.PAY)) {
    return;
  }
  const facts = {
    autocomplete: el.getAttribute('autocomplete') ?? undefined,
    name: el.getAttribute('name') ?? undefined,
    id: el.getAttribute('id') ?? undefined,
    inputMode: el.getAttribute('inputmode') ?? undefined,
    label: `${getAccessibleName(el)} ${el.getAttribute('placeholder') ?? ''}`,
  };
  if (isPaymentField(facts)) {
    throw new Error(outwardRefusal(OutwardAction.PAY));
  }
}
