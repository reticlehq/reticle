/**
 * The founder card, one slide of the chat panel's carousel.
 *
 * The carousel owns placement and removal; this card only has to say the right thing and point at the
 * one booking link core keeps, so the panel, the CLI and the agent's instructions never disagree.
 */
import { describe, expect, it } from 'vitest';
import { DISCOVERY_CALL_URL, DISCOVERY_EMAIL_COMMAND } from '@reticlehq/core';
import { TALK_BOOK_ATTR, TALK_TEXT, talkCardHtml } from './talk-card.js';

describe('talkCardHtml', () => {
  it('is titled "Talk to Founders" and links to the founder calendar in a new tab', () => {
    const host = document.createElement('div');
    host.innerHTML = talkCardHtml();
    expect(TALK_TEXT.HEADLINE).toBe('Talk to Founders');
    expect(host.textContent).toContain(TALK_TEXT.HEADLINE);
    const book = host.querySelector(`[${TALK_BOOK_ATTR}]`);
    expect(book?.getAttribute('href')).toBe(DISCOVERY_CALL_URL);
    expect(book?.getAttribute('target')).toBe('_blank');
    expect(book?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  // Asked for directly: a card in the HUD is a headline and a line of text, never a command to run.
  it('shows no command or code, only a short headline and a short line', () => {
    const html = talkCardHtml();
    expect(html).not.toContain(DISCOVERY_EMAIL_COMMAND);
    expect(html).not.toContain('<code');
    expect(TALK_TEXT.HEADLINE.length).toBeLessThanOrEqual(30);
    expect(TALK_TEXT.BODY.length).toBeLessThanOrEqual(60);
  });
});
