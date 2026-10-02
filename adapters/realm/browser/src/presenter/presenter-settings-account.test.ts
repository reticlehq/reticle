/**
 * The settings panel's account row, and the same three-state rule every other surface obeys.
 *
 * This is the THIRD surface to show account state, which is why the builder is shared: the rule
 * — absent means UNKNOWN, never signed-out — is the part worth keeping identical, and a rule copied
 * into three panels is a rule that will be right in two of them.
 */

import { describe, expect, it } from 'vitest';
import { paintSettingsAccount, settingsPanelHtml } from './presenter-settings.js';
import { ACCOUNT_SIGNIN_ATTR, ACCOUNT_TEXT } from './presenter-account.js';

const DASHBOARD = 'https://app.reticle.sh/p/acme';

function panel(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = settingsPanelHtml();
  return root;
}

const row = (root: HTMLElement): HTMLElement | null =>
  root.querySelector('[data-reticle-settings-account-row]');

describe('the settings panel says whether this machine is signed in', () => {
  it('hides the row entirely when the daemon sent no account state', () => {
    const root = panel();
    paintSettingsAccount(root, undefined, DASHBOARD);
    expect(row(root)?.hidden, 'absent is UNKNOWN, and a guess here is the nag').toBe(true);
  });

  it('shows the org and a way through when signed in and linked', () => {
    const root = panel();
    paintSettingsAccount(root, { signedIn: true, org: 'Acme Corp' }, DASHBOARD);
    expect(row(root)?.hidden).toBe(false);
    expect(root.innerHTML).toContain('AC');
    expect(root.innerHTML).toContain(DASHBOARD);
  });

  /*
   * Settings MAY offer sign-in where the report panel may not. The rule is not chrome-versus-panel
   * but whether account state is the SUBJECT of the surface: somebody reading a verdict did not ask
   * about their account; somebody who opened Settings is asking exactly this.
   */
  it('offers sign-in when signed out, because that is what this panel is for', () => {
    const root = panel();
    paintSettingsAccount(root, { signedIn: false }, undefined);
    expect(row(root)?.hidden).toBe(false);
    expect(root.innerHTML).toContain(ACCOUNT_SIGNIN_ATTR);
    expect(root.innerHTML).toContain(ACCOUNT_TEXT.SIGNED_OUT);
  });

  it('repaints from unknown to signed-in without leaving the old state behind', () => {
    const root = panel();
    paintSettingsAccount(root, { signedIn: false }, undefined);
    paintSettingsAccount(root, { signedIn: true, org: 'Acme' }, DASHBOARD);
    expect(root.innerHTML, 'a stale Sign in button would outlive the sign-in').not.toContain(
      ACCOUNT_SIGNIN_ATTR,
    );
  });
});
