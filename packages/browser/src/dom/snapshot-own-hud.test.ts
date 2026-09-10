/**
 * Reticle's own HUD is not the application's modal.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { buildSnapshot } from './snapshot.js';
import { setPresenterVisible } from './dom-ignore.js';

beforeEach(() => {
  document.body.innerHTML = '';
  setPresenterVisible(true); // the app under test IS Reticle — the only case where the HUD is visible
});

/** The label the fixture uses — asserted against, so the two cannot drift apart silently. */
const appHudLabel = (): string | undefined =>
  document.querySelector('[data-reticle-hud] [role="dialog"]')?.getAttribute('aria-label') ??
  undefined;

const appWithHud = (): void => {
  document.body.innerHTML = `
    <main><h1>Issues</h1><ul data-testid="issue-list"><li>a defect</li></ul></main>
    <div data-reticle-hud>
      <div role="dialog" aria-label="Reticle session">session</div>
    </div>`;
};

describe('the HUD never masquerades as the app', () => {
  it('is not reported as an open dialog', () => {
    appWithHud();
    const snap = buildSnapshot();
    // Telling an agent a modal is up when the app has none makes it dismiss something first —
    // wasted at best, and it dismisses a REAL dialog at worst.
    expect(snap.status?.visibleDialogs ?? []).not.toContain('Reticle session');
    // And not vacuously: the fixture's label is what the HUD actually renders, so a rename that
    // forgot this assertion would make it pass by describing a panel that does not exist.
    expect(appHudLabel(), 'fixture must use the label the shell really ships').toBe(
      'Reticle session',
    );
  });

  it('a REAL app dialog is still reported alongside it', () => {
    appWithHud();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div role="dialog" aria-label="Delete workspace">sure?</div>',
    );
    expect(buildSnapshot().status?.visibleDialogs ?? []).toStrictEqual(['Delete workspace']);
  });

  it('does not explain an empty page with itself', () => {
    // The app is aria-hidden, and the ONLY dialog present is ours. The overlay hint must not fire:
    // it would send the reader to dismiss a panel that was never the cause.
    document.body.innerHTML = `
      <main aria-hidden="true"><h1>Issues</h1></main>
      <div data-reticle-hud>
        <div role="dialog" aria-label="Reticle session">session</div>
      </div>`;
    const snap = buildSnapshot();
    expect(JSON.stringify(snap.status ?? {})).not.toContain('focus-trap modal');
  });
});
