/**
 * `reticle init` must keep Reticle's local state out of the project's `prettier --check`.
 *
 * The nested `.reticle/.gitignore` does not help — Prettier only reads the ignore file of the
 * directory it runs from — and matching Prettier's exact JSON output is a losing game
 * (Prettier keeps short arrays on one line; `JSON.stringify` does not always agree). So when
 * the project uses Prettier, `init` adds `.reticle/` to the project's `.prettierignore`.
 */

import { describe, expect, it } from 'vitest';
import {
  PRETTIERIGNORE_PATH,
  RETICLE_IGNORE_ENTRY,
  ignoresReticle,
  withReticleIgnored,
} from './prettier-ignore.js';

describe('detecting an existing .reticle/ exclusion', () => {
  it('matches the entry with a trailing slash', () => {
    expect(ignoresReticle('# comment\n.reticle/\n')).toBe(true);
  });

  it('matches the entry without a trailing slash', () => {
    expect(ignoresReticle('.reticle\n')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    expect(ignoresReticle('# .reticle/\n\n')).toBe(false);
  });

  it('is false for unrelated entries', () => {
    expect(ignoresReticle('node_modules/\ndist/\n')).toBe(false);
  });
});

describe('building the updated .prettierignore', () => {
  it('creates one when none exists', () => {
    const content = withReticleIgnored(null);
    expect(content).toContain(RETICLE_IGNORE_ENTRY);
    expect(content.endsWith('\n')).toBe(true);
    expect(ignoresReticle(content)).toBe(true);
  });

  it('appends the entry to an existing file without duplicating', () => {
    const content = withReticleIgnored('node_modules/\n');
    expect(content).toContain('node_modules/');
    // Exactly one ignore-pattern line for .reticle/ (the header comment also mentions it).
    const patternLines = content.split('\n').filter((line) => '.reticle/' === line.trim());
    expect(patternLines).toHaveLength(1);
  });

  it('leaves a file that already excludes .reticle/ unchanged', () => {
    const existing = 'node_modules/\n.reticle/\n';
    expect(withReticleIgnored(existing)).toBe(existing);
  });

  it('the path constant is the project-root .prettierignore', () => {
    expect(PRETTIERIGNORE_PATH).toBe('.prettierignore');
  });
});
