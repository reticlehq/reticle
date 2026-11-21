/**
 * What a HELLO tells a session that it already has
 *
 * The SDK sends HELLO again when the app registers capabilities, and after a reload. This takes the
 * mutable half of the session's identity from it, and the page language each HELLO announced.
 */
import type { HelloMessage } from '@reticlehq/core';
import { forgetRecordedGaps } from './recorded-gaps.js';
import type { Session } from './session.js';

/**
 * The page language per session. Kept beside the session, not on it: `session.ts` is at the line
 * cap, and only flow recording and replay read the language. A WeakMap, so the entry goes with the
 * session.
 */
const languages = new WeakMap<object, string>();

/** Take the language from a HELLO, first or repeat. A HELLO with no `lang` clears an older one. */
export function notePageLanguage(session: object, hello: Pick<HelloMessage, 'lang'>): void {
  if (hello.lang === undefined) {
    languages.delete(session);
    return;
  }
  languages.set(session, hello.lang);
}

/** The page language (`<html lang>`) of the session's page. Undefined when the page sets none. */
export function pageLanguageOf(session: object): string | undefined {
  return languages.get(session);
}

/**
 * Take the mutable half of a session's identity from a repeat HELLO; the caller has established the
 * hello belongs to this session. Capabilities and stores register AFTER connect() by design, so
 * `hasCapabilities` and `channels` come again here. A late project id is taken by `adoptProject`.
 * The page announced itself again, so gaps that earlier verdicts recorded are dropped (#1655).
 */
export function refreshIdentity(session: Session, hello: HelloMessage): void {
  session.url = hello.url;
  session.title = hello.title;
  notePageLanguage(session, hello);
  session.adapters = hello.adapters;
  session.hasCapabilities = hello.hasCapabilities ?? false;
  session.channels = hello.channels;
  forgetRecordedGaps(session.id);
}
