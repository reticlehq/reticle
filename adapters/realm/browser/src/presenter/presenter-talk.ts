/**
 * The in-page invitation to talk to the founder: where Reticle got in the way, and what it should do.
 *
 * Shown in the panel a developer already has open while Reticle runs. The link and the email command
 * come from core's one discovery module, so this card, the CLI and the agent instructions can never
 * point at different places.
 *
 * Dismissible for the tab SESSION, and back in the next: it is offered at every qualifying moment by
 * choice, and "not now" is not "never" — unlike the harness offer, whose "no" answers for good.
 */
import { DISCOVERY_CALL_URL, DISCOVERY_EMAIL_COMMAND } from '@reticlehq/core';

/** The empty slot the shell renders once and this file paints into. */
export const TALK_SLOT_ATTR = 'data-reticle-talk-slot';
/** The booking link. */
export const TALK_BOOK_ATTR = 'data-reticle-talk-book';
/** The dismissal control. */
export const TALK_DISMISS_ATTR = 'data-reticle-talk-dismiss';
/** Where "not now" is remembered — session storage, so it lasts this tab and no longer. */
export const TALK_DISMISSED_KEY = 'reticle.talkToUs.dismissed';

/** What the card says. Named because a string a user reads is a decision. */
export const TALK_TEXT = {
  HEADLINE: 'Talk to the founder',
  BODY: 'Tell us where Reticle got in your way and what it should do next.',
  BOOK: 'Book a call',
  EMAIL: 'or leave your email:',
  DISMISS: 'Not now',
} as const;

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Whether "not now" was said in this tab session. A store that refuses reads as no. */
export function talkDismissed(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return '1' === storage?.getItem(TALK_DISMISSED_KEY);
  } catch {
    return false;
  }
}

/** The card's markup, or empty once dismissed for this session. */
export function talkHtml(dismissed: boolean): string {
  if (dismissed) return '';
  return `<div class="reticle-talk" role="note">
      <span class="reticle-talk-title">${escape(TALK_TEXT.HEADLINE)}</span>
      <p class="reticle-talk-body">${escape(TALK_TEXT.BODY)}</p>
      <div class="reticle-talk-actions">
        <a ${TALK_BOOK_ATTR} class="reticle-talk-book" href="${escape(DISCOVERY_CALL_URL)}" target="_blank" rel="noopener noreferrer">${escape(TALK_TEXT.BOOK)}</a>
        <button type="button" ${TALK_DISMISS_ATTR} class="reticle-talk-dismiss">${escape(TALK_TEXT.DISMISS)}</button>
      </div>
      <p class="reticle-talk-email">${escape(TALK_TEXT.EMAIL)} <code>${escape(DISCOVERY_EMAIL_COMMAND)}</code></p>
    </div>`;
}

/** Paint the card into its slot and wire the one control it owns. */
export function paintTalk(
  root: ParentNode,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
): void {
  const slot = root.querySelector(`[${TALK_SLOT_ATTR}]`);
  if (!(slot instanceof HTMLElement)) return;
  slot.innerHTML = talkHtml(talkDismissed(storage));
  slot.querySelector(`[${TALK_DISMISS_ATTR}]`)?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      storage?.setItem(TALK_DISMISSED_KEY, '1');
    } catch {
      /* the card closes either way; it simply returns on the next paint */
    }
    slot.innerHTML = '';
  });
}

/** Styles, beside the markup they dress. Reuses the panel's tokens, as the harness offer does. */
export const TALK_CSS = `
.reticle-talk{margin:8px 10px;padding:10px 12px;border:1px solid var(--reticle-line,#2a2f3a);border-radius:10px;background:var(--reticle-surface-inset,rgba(255,255,255,.03));}
.reticle-talk-title{font-weight:600;font-size:12px;}
.reticle-talk-body{margin:6px 0 8px;font-size:11px;line-height:1.45;opacity:.8;}
.reticle-talk-actions{display:flex;align-items:center;gap:8px;}
.reticle-talk-book{font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;background:var(--reticle-accent,#4f7cff);color:#fff;text-decoration:none;}
.reticle-talk-dismiss{font-size:11px;padding:4px 8px;border-radius:6px;background:none;border:0;color:inherit;opacity:.6;cursor:pointer;}
.reticle-talk-dismiss:hover{opacity:1;}
.reticle-talk-email{margin:8px 0 0;font-size:10px;opacity:.6;word-break:break-all;}
`;
