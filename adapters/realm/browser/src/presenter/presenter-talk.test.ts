/**
 * The in-page invitation to talk to the founder.
 *
 * Always there while Reticle runs, because the panel is the surface a developer already has open.
 * Dismissible for the tab session and back in the next one: the person asked for it at every
 * qualifying moment, and "not now" is not "never".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DISCOVERY_CALL_URL, DISCOVERY_EMAIL_COMMAND } from '@reticlehq/core';
import {
  TALK_BOOK_ATTR,
  TALK_DISMISS_ATTR,
  TALK_DISMISSED_KEY,
  TALK_SLOT_ATTR,
  paintTalk,
  talkHtml,
} from './presenter-talk.js';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
  };
}

describe('talkHtml', () => {
  it('links to the founder calendar in a new tab, and names the email route', () => {
    const html = talkHtml(false);
    expect(html).toContain(`href="${DISCOVERY_CALL_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(DISCOVERY_EMAIL_COMMAND);
  });

  it('is empty once dismissed for this session', () => {
    expect(talkHtml(true)).toBe('');
  });
});

describe('paintTalk', () => {
  beforeEach(() => {
    document.body.innerHTML = `<div ${TALK_SLOT_ATTR}></div>`;
  });

  it('paints the card, and "not now" clears it for the rest of the session', () => {
    const storage = memoryStorage();
    paintTalk(document.body, storage);
    expect(document.querySelector(`[${TALK_BOOK_ATTR}]`)).not.toBeNull();
    (document.querySelector(`[${TALK_DISMISS_ATTR}]`) as HTMLElement).click();
    expect(document.querySelector(`[${TALK_BOOK_ATTR}]`)).toBeNull();
    expect(storage.getItem(TALK_DISMISSED_KEY)).toBe('1');
    paintTalk(document.body, storage);
    expect(document.querySelector(`[${TALK_BOOK_ATTR}]`)).toBeNull();
  });
});
