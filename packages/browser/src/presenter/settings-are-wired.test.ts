/**
 * Every setting must actually DO something.
 *
 * A settings panel is the easiest place in a UI to ship a control that changes nothing: the toggle
 * flips, the value persists, the panel repaints, and no behaviour anywhere reads it. Nothing else in
 * this suite would notice — the setting has tests, they pass, and the feature is absent.
 *
 * So each key is checked to be READ somewhere outside the settings module itself. Reading is the
 * weakest claim that can be made mechanically and it is the one that fails when a setting is
 * decorative; whether the behaviour behind it is correct is the job of that behaviour's own tests.
 *
 * Two spellings count as a read, because the codebase legitimately uses both: the key named directly
 * (`settings.showTally`), or an attribute this module stamps on the root for CSS to act on
 * (`data-reticle-reduce-motion`). An attribute with no rule anywhere is treated as unread, which is
 * the actual failure mode — the attribute lands and nothing responds to it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPresenterSettings } from './presenter-settings.js';

const SRC = path.resolve(__dirname, '..');
const SETTINGS_FILE = 'presenter-settings.ts';

/** Every .ts under packages/browser/src, excluding tests and the settings module itself. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

/**
 * The attribute - or CSS custom property - a setting is stamped as, when it is applied that way
 * rather than read directly. A custom property counts for the same reason an attribute does: the
 * settings module writes it, and something else has to consume it or the control does nothing.
 */
const ATTR_FOR_KEY: Readonly<Record<string, string>> = {
  hideUntilRestart: 'data-reticle-hidden',
  showTimestamps: 'data-reticle-log-ts',
  compactChat: 'data-reticle-compact-chat',
  reduceMotion: 'data-reticle-reduce-motion',
  accentColorId: 'data-reticle-accent',
  statusThemeId: '--reticle-c-active',
  ambientGlow: 'data-reticle-ambient-glow',
};

describe('every presenter setting is read by something', () => {
  const files = sources(SRC).filter((f) => !f.endsWith(SETTINGS_FILE));
  const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const keys = Object.keys(loadPresenterSettings());

  it('finds the settings and the source to check them against', () => {
    expect(keys.length).toBeGreaterThan(5);
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(keys)('%s is read outside the settings module', (key) => {
    const attr = ATTR_FOR_KEY[key];
    const readDirectly = corpus.includes(key);
    const readAsAttribute = attr !== undefined && corpus.includes(attr);
    expect(
      readDirectly || readAsAttribute,
      `nothing outside ${SETTINGS_FILE} reads "${key}". A setting that is stored, persisted and ` +
        `painted but never read is a control that does nothing — either wire it up or remove it.`,
    ).toBe(true);
  });
});
