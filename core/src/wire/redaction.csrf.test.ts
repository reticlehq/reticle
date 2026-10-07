import { describe, expect, it } from 'vitest';
import { defaultIsSensitiveKey } from './redaction.js';

/**
 * A CSRF token is a credential under its bare name too, not only as `csrf-token`.
 *
 * Spring Security renders its token as `<meta name="_csrf" content="…">`, and Express's csurf keeps
 * its secret in a cookie named `_csrf`. The key rule caught Rails' `csrf-token` and `csrf_token` but
 * not the bare name, which mattered the moment the SDK could read `<head>` meta tags (#1425): the
 * token would have reached the agent as the content of a meta tag nobody asked about.
 */
describe('the key rule covers a bare CSRF name', () => {
  for (const key of ['_csrf', 'csrf', 'xsrf', '_csrf_header', 'csrf-param']) {
    it(`redacts ${key}`, () => {
      expect(defaultIsSensitiveKey(key)).toBe(true);
    });
  }

  // Boundary-anchored like `card` and `pan`, so a word that merely contains the letters stays visible.
  for (const key of ['description', 'csrfless', 'og:image', 'viewport', 'scsrfx']) {
    it(`leaves ${key} visible`, () => {
      expect(defaultIsSensitiveKey(key)).toBe(false);
    });
  }
});
