import { afterEach, describe, expect, it } from 'vitest';
import { LOG_KIND, LOG_RESULT } from './presenter-log.js';
import { Presenter } from '../presenter.js';
import { claimLog, readRememberedLog, rememberLog } from './log-memory.js';

/**
 * Found watching the Harness replay saved flows on the merchant dashboard: each replay reloads the
 * page, and the Agent Log emptied with it, every few seconds, for the whole drive.
 */
describe('the Agent Log across a reload', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  const rows = (): string[] =>
    Array.from(document.querySelectorAll('[data-reticle-log] [data-reticle-log-row]')).map(
      (row) => row.textContent ?? '',
    );

  it('shows the rows the tab had, with their outcome, after the page comes back', () => {
    const before = new Presenter({});
    before.mount();
    before.log(LOG_KIND.NARRATION, 'Harness is driving');
    before.log(LOG_KIND.ACT, 'Clicking button "Refund now"')?.result(LOG_RESULT.FAIL);
    // A reload: the page and the HUD go away without the SDK tearing anything down.
    document.body.innerHTML = '';

    const after = new Presenter({});
    after.mount();
    const shown = rows().join('\n');
    expect(shown).toContain('Harness is driving');
    expect(shown).toContain('Clicking button "Refund now"');
    expect(document.querySelector('[data-reticle-log] [data-state="fail"]')).not.toBeNull();
    after.destroy();
  });
});

/** The log holds what was driven and the notes a person wrote: never shown to the next account. */
describe('the Agent Log when the account on the tab changes', () => {
  afterEach(() => sessionStorage.clear());
  const row = { kind: LOG_KIND.HUMAN, text: 'my private note', ts: '10:00', at: 0 };

  it('is forgotten when somebody else signs in, and kept for the same account', () => {
    expect(claimLog('ada@example.com')).toBe(false);
    rememberLog([row]);
    expect(claimLog('ada@example.com')).toBe(false);
    expect(readRememberedLog()).toHaveLength(1);
    expect(claimLog('grace@example.com')).toBe(true);
    expect(readRememberedLog()).toEqual([]);
  });

  it('is forgotten on sign-out', () => {
    claimLog('ada@example.com');
    rememberLog([row]);
    expect(claimLog(undefined)).toBe(true);
    expect(readRememberedLog()).toEqual([]);
  });
});
