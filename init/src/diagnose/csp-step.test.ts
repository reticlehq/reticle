/**
 * `reticle doctor` and `init` must say the same thing about one policy.
 *
 * On electron-vite's own template (`default-src 'self'; script-src 'self'`) `init` reported the
 * connect-src block that actually stops the bridge, while `doctor` — defaulting to "the app pastes an
 * inline snippet" — reported the inline-script rule and prescribed moving a snippet the app does not
 * have. Both now take the wiring from the one rule below.
 */

import { describe, expect, it } from 'vitest';
import { Framework } from '@/detect/detect.js';
import { externalScriptRemedy } from './csp-check.js';
import { diagnoseWebCsp } from './csp-doctor.js';
import { webCspOptionsFor } from './csp-step.js';

const ELECTRON_VITE_TEMPLATE =
  '<html><head><meta http-equiv="Content-Security-Policy" ' +
  "content=\"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'\" />" +
  '</head><body></body></html>';

const read = (file: string): string | undefined =>
  'index.html' === file ? ELECTRON_VITE_TEMPLATE : undefined;

describe('the wiring a CSP diagnosis assumes', () => {
  it('reports connect-src, not the inline-script rule, for a plugin-wired app', () => {
    const [first] = diagnoseWebCsp(read, 4400, [], webCspOptionsFor(Framework.ELECTRON_VITE));
    expect(first?.fix).not.toBe(externalScriptRemedy());
    expect(first?.problem).toMatch(/connect-src/);
  });

  it('keeps the inline-script rule for the plain-HTML paste-in snippet', () => {
    const [first] = diagnoseWebCsp(read, 4400, [], webCspOptionsFor(Framework.HTML));
    expect(first?.fix).toBe(externalScriptRemedy());
  });

  it('keeps the conservative default when the wiring is unknown', () => {
    expect(webCspOptionsFor(undefined)).toEqual({});
  });
});
