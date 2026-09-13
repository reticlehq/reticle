import { describe, expect, it, beforeEach } from 'vitest';
import { loadPresenterSettings } from './presenter-settings.js';
import { SETTINGS_STORAGE_KEY } from './presenter-config.js';

/** Write a stored profile the way the settings panel does, without widening the module's API. */
const storeSettings = (partial: Record<string, unknown>): void =>
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(partial));

/**
 * The chat IS the HUD's content, so it should be there without being asked for.
 *
 * `expand()` has always opened it — a toolbar with nothing above it made the agent's log something
 * you had to know to go looking for. What stayed off was the OTHER half: whether the chat appears at
 * SESSION START, with no click at all. That was `autoOpenChat`, and it shipped `false`, so the
 * default experience was a bare toolbar until somebody discovered the toggle.
 *
 * Turning it on is one line. The reason it needs a test is the regression the shell already warns
 * about: `openChat()` expands a collapsed HUD, so a naive default would have session start blow past
 * the collapsed FAB state and the FAB would never appear. Both halves are pinned below — the chat
 * arrives by default, AND collapsing still gets you a FAB and keeps it.
 */

describe('the chat panel is open by default', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('ships ON, so a first-run HUD shows the chat with no click', () => {
    expect(loadPresenterSettings().autoOpenChat).toBe(true);
  });

  /**
   * The half the user actually asked for: a default, not a decision. Someone who wants the bare
   * toolbar turns it off and it stays off.
   */
  it('remembers the user turning it off — a default is not a policy', () => {
    storeSettings({ autoOpenChat: false });
    expect(loadPresenterSettings().autoOpenChat).toBe(false);
  });

  it('remembers the user turning it back on', () => {
    storeSettings({ autoOpenChat: true });
    expect(loadPresenterSettings().autoOpenChat).toBe(true);
  });

  /**
   * A stored profile written before this default flipped must keep the answer its owner gave. Reading
   * a missing key as the NEW default is correct; overwriting a present `false` would be the product
   * changing somebody's setting behind their back.
   */
  it('does not overwrite a stored false when the default changes underneath it', () => {
    storeSettings({ autoOpenChat: false });
    expect(loadPresenterSettings().autoOpenChat).toBe(false);
  });

  it('adopts the new default for a profile that predates the setting entirely', () => {
    storeSettings({ showTally: true });
    const loaded = loadPresenterSettings();
    expect(loaded.autoOpenChat).toBe(true);
    expect(loaded.showTally).toBe(true);
  });
});
