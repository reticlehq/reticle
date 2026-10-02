/**
 * The account control is styled ONCE, and every surface gets that one design.
 *
 * Three copies of these rules used to exist -- scoped to the chat panel, the settings panel and the
 * report panel -- and they had drifted to `gap:4px` against `gap:6px`, `display:inline-flex` against
 * `display:flex`, and 22px against 20px avatars. The same control therefore looked like three
 * controls depending on where you met it. This fails if a fourth copy appears, or if the shared sheet
 * stops being unscoped.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_CSS } from './presenter-account-styles.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8');

/** Every stylesheet that could re-introduce a per-panel copy. */
const SIBLING_SHEETS = [
  'presenter-controls.ts',
  'presenter-settings-styles.ts',
  'presenter-report-styles.ts',
  'presenter-shell-styles.ts',
];

describe('one design, one stylesheet', () => {
  it('is the only place that styles the account control', () => {
    for (const sheet of SIBLING_SHEETS) {
      const src = read(sheet);
      const offending = src
        .split('\n')
        .filter((line) => line.includes('.reticle-account'))
        .filter((line) => !line.trimStart().startsWith('*'));
      expect(
        offending,
        `${sheet} styles .reticle-account again — that is how the three copies drifted apart`,
      ).toEqual([]);
    }
  });

  it('keys off the class alone, so a new surface inherits the design by mounting the markup', () => {
    // A panel-scoped selector would mean a fourth surface silently rendering an unstyled control,
    // which is the 0x0 capsule this replaced.
    for (const rule of ACCOUNT_CSS.split('}')) {
      const selector = rule.split('{')[0] ?? '';
      if (!selector.includes('.reticle-account')) continue;
      expect(
        selector.includes('[data-reticle-settings-panel]') ||
          selector.includes('[data-reticle-report-panel]') ||
          selector.includes('[data-reticle-chat-panel]'),
        `scoped to a panel, so other surfaces get nothing: ${selector.trim()}`,
      ).toBe(false);
    }
  });

  it('gives the avatar exactly one size, not one per surface', () => {
    const sizes = [
      ...ACCOUNT_CSS.matchAll(/\.reticle-account-avatar\b[^{]*\{[^}]*?width:(\d+)px/g),
    ].map((m) => m[1]);
    // Two: the trigger's avatar and the menu's larger one. Both from the same tokens.
    expect(
      new Set(sizes).size,
      'more than two avatar sizes means the drift is back',
    ).toBeLessThanOrEqual(2);
  });

  /*
   * A backtick inside this template literal terminates it, and the file then fails to parse in a way
   * whose error points at the CSS rather than at the quote. It cost four rebuilds while this control
   * was being written, and the same mistake -- a backtick inside an unquoted heredoc -- is what
   * pasted a repository listing into shipped source earlier in this release.
   */
  it('contains no backtick, which would terminate its own template literal', () => {
    expect(ACCOUNT_CSS).not.toContain('`');
  });
});
