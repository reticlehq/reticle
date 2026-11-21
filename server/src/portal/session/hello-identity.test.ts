import { describe, expect, it } from 'vitest';
import { notePageLanguage, pageLanguageOf } from './hello-identity.js';

/** The page language a HELLO announced, kept per session (#2278). */
describe('the page language of a session', () => {
  it('is the lang of the last HELLO', () => {
    const session = {};
    notePageLanguage(session, { lang: 'en' });
    notePageLanguage(session, { lang: 'ar' });
    expect(pageLanguageOf(session)).toBe('ar');
  });

  it('is cleared by a HELLO with no lang, so an old language is not kept', () => {
    const session = {};
    notePageLanguage(session, { lang: 'en' });
    notePageLanguage(session, {});
    expect(pageLanguageOf(session)).toBeUndefined();
  });

  it('is undefined for a session that never announced one', () => {
    expect(pageLanguageOf({})).toBeUndefined();
  });
});
