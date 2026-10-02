import { describe, expect, it } from 'vitest';
import { RETICLE_URL_PARAM } from '@reticlehq/core';
import { stampedDriveUrl } from './drive-url-stamp.js';

/**
 * `reticle drive` opened a page that did not say who opened it.
 *
 * The lease pool stamps `__reticle_session` onto every URL it opens, and the SDK reads that to know
 * a page belongs to Reticle rather than to a person. The launched provider navigated to the bare
 * `driveUrl`, so its page looked exactly like a developer's own tab — and got the first-run tour,
 * whose scrim then swallowed every native click and hover the drive tried to make.
 *
 * MEASURED: `drive-launch-test` hovering the smart-sentence reported `dispatched: true,
 * inputMode: "real"` and no `mouseenter`, because the move landed on `.reticle-tour-scrim`.
 */
describe('the URL a drive opens', () => {
  it('carries the opened stamp, so the page knows Reticle opened it', () => {
    const url = new URL(stampedDriveUrl('http://localhost:3100/'));
    expect(url.searchParams.get(RETICLE_URL_PARAM.OPENED)).toBe('1');
  });

  it('does NOT touch the session param, which doubles as the session id', () => {
    // Stamping SESSION here renamed every driven session to one shared constant: an app that names
    // no session takes the URL's, so two concurrent drives would have collided on it.
    const url = new URL(stampedDriveUrl('http://localhost:3100/'));
    expect(url.searchParams.has(RETICLE_URL_PARAM.SESSION)).toBe(false);
  });

  it('keeps the app’s own query params and hash untouched', () => {
    const url = new URL(stampedDriveUrl('http://localhost:3100/x?a=1&b=2#frag'));
    expect(url.searchParams.get('a')).toBe('1');
    expect(url.searchParams.get('b')).toBe('2');
    expect(url.hash).toBe('#frag');
    expect(url.pathname).toBe('/x');
  });

  it('leaves a session the caller named exactly as it was', () => {
    const already = `http://localhost:3100/?${RETICLE_URL_PARAM.SESSION}=mine`;
    const url = new URL(stampedDriveUrl(already));
    expect(url.searchParams.get(RETICLE_URL_PARAM.SESSION)).toBe('mine');
    expect(url.searchParams.get(RETICLE_URL_PARAM.OPENED)).toBe('1');
  });

  it('hands back anything it cannot parse, rather than losing the navigation', () => {
    // A drive must still happen. Refusing to navigate because a URL looked odd would trade a
    // cosmetic stamp for the whole feature.
    expect(stampedDriveUrl('not a url')).toBe('not a url');
  });
});
