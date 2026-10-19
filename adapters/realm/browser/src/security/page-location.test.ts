/**
 * A sign-in left `#access_token=…` in the address, and the snapshot route and the hello sent it raw.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pageHref, pageRoute } from './page-location.js';

afterEach(() => {
  history.replaceState(null, '', '/');
});

describe('the page address the SDK sends', () => {
  it('redacts a token in the fragment and the query', () => {
    history.replaceState(null, '', '/cb?access_token=qtok#access_token=ftok&refresh_token=rtok');
    for (const sent of [pageHref(), pageRoute(), pageRoute(false)]) {
      for (const secret of ['qtok', 'ftok', 'rtok']) expect(sent).not.toContain(secret);
    }
    expect(pageRoute()).toContain('/cb');
  });

  it('keeps a plain anchor and a hash-router path readable', () => {
    history.replaceState(null, '', '/docs#section');
    expect(pageRoute()).toBe('/docs#section');
    history.replaceState(null, '', '/app#/users/5');
    expect(pageRoute()).toBe('/app#/users/5');
  });
});
