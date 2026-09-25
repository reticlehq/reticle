/**
 * The founder card: where Reticle got in the way, and what it should do next.
 *
 * One slide of the chat panel's carousel, which owns where it sits and how it is closed. The link and
 * the email command come from core's one discovery module, so this card, the CLI and the agent's
 * instructions can never point at different places.
 */
import { DISCOVERY_CALL_URL, DISCOVERY_EMAIL_COMMAND } from '@reticlehq/core';

/** The booking link. */
export const TALK_BOOK_ATTR = 'data-reticle-talk-book';

/** What the card says. Named because a string a user reads is a decision. */
export const TALK_TEXT = {
  HEADLINE: 'Talk to Founders',
  BODY: 'Tell us where Reticle got in your way and what it should do next.',
  BOOK: 'Book a call',
  EMAIL: 'or leave your email:',
} as const;

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function talkCardHtml(): string {
  return `<div class="reticle-talk">
      <span class="reticle-talk-title">${escape(TALK_TEXT.HEADLINE)}</span>
      <p class="reticle-talk-body">${escape(TALK_TEXT.BODY)}</p>
      <a ${TALK_BOOK_ATTR} class="reticle-talk-book" href="${escape(DISCOVERY_CALL_URL)}" target="_blank" rel="noopener noreferrer">${escape(TALK_TEXT.BOOK)}</a>
      <p class="reticle-talk-email">${escape(TALK_TEXT.EMAIL)} <code>${escape(DISCOVERY_EMAIL_COMMAND)}</code></p>
    </div>`;
}

/** Styles, beside the markup they dress. Reuses the panel's tokens, as the harness card does. */
export const TALK_CSS = `
.reticle-talk-title{display:block;font-weight:600;font-size:12px;padding-right:18px;}
.reticle-talk-body{margin:6px 0 8px;font-size:11px;line-height:1.45;opacity:.8;}
.reticle-talk-book{display:inline-block;font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;background:var(--reticle-accent,#4f7cff);color:#fff;text-decoration:none;}
.reticle-talk-email{margin:8px 0 0;font-size:10px;opacity:.6;overflow-wrap:anywhere;}
`;
