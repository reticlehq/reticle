/**
 * The account menu: what it says, and what it refuses to say.
 *
 * The control is mounted on three surfaces from one builder, so these assert the BUILDER. The
 * placement and the push-race live in presenter-account-push-before-mount.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_MENU_ATTR,
  ACCOUNT_SIGNOUT_ATTR,
  ACCOUNT_TEXT,
  ACCOUNT_TRIGGER_ATTR,
  accountControlHtml,
  mountAccountControl,
} from './presenter-account.js';

const DASHBOARD = 'https://app.reticle.sh/p/acme';
const SIGNED_IN = { signedIn: true, org: 'Acme Corp' } as const;

function mounted(html: string): { root: HTMLElement; teardown: () => void } {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return { root, teardown: mountAccountControl(root) };
}

const menu = (root: HTMLElement): HTMLElement | null =>
  root.querySelector(`[${ACCOUNT_MENU_ATTR}]`);
const trigger = (root: HTMLElement): HTMLElement | null =>
  root.querySelector(`[${ACCOUNT_TRIGGER_ATTR}]`);

describe('what the menu reports', () => {
  it('names the org and the host, so "signed in" says WHERE', () => {
    const html = accountControlHtml(SIGNED_IN, { dashboardUrl: DASHBOARD });
    expect(html).toContain('Acme Corp');
    const withHost = accountControlHtml(
      { ...SIGNED_IN, host: 'https://app.reticle.sh' },
      { dashboardUrl: DASHBOARD },
    );
    expect(withHost).toContain(ACCOUNT_TEXT.HOST_LABEL);
    expect(withHost).toContain('https://app.reticle.sh');
  });

  it('carries the project and its counts, which are the details worth having here', () => {
    const html = accountControlHtml(SIGNED_IN, {
      dashboardUrl: DASHBOARD,
      projectName: 'checkout',
      verdicts: 42,
      defects: 7,
    });
    expect(html).toContain('checkout');
    expect(html).toContain('42');
    expect(html).toContain('7');
  });

  /* An empty row states a fact it does not have. */
  it('omits a row it has no value for rather than printing a blank', () => {
    const html = accountControlHtml(SIGNED_IN, { dashboardUrl: DASHBOARD });
    expect(html).not.toContain(ACCOUNT_TEXT.PROJECT_LABEL);
    expect(html).not.toContain(ACCOUNT_TEXT.VERDICTS_LABEL);
  });

  it('offers the dashboard when linked, and the way to link when not', () => {
    expect(accountControlHtml(SIGNED_IN, { dashboardUrl: DASHBOARD })).toContain(
      ACCOUNT_TEXT.DASHBOARD_ACTION,
    );
    const unlinked = accountControlHtml(SIGNED_IN, {});
    expect(unlinked, 'a link to an unlinked project would 404').not.toContain(
      ACCOUNT_TEXT.DASHBOARD_ACTION,
    );
    expect(unlinked).toContain(ACCOUNT_TEXT.LINK_COMMAND);
  });

  it('shows an email only when the daemon sent one', () => {
    expect(accountControlHtml(SIGNED_IN, {})).not.toContain('@');
    const withEmail = accountControlHtml({ ...SIGNED_IN, email: 'dev@acme.test' }, {});
    expect(withEmail).toContain('dev@acme.test');
  });

  it('never renders a menu for an unknown or signed-out account', () => {
    expect(accountControlHtml(undefined, { dashboardUrl: DASHBOARD })).toBe('');
    expect(accountControlHtml({ signedIn: false }, {}, true)).not.toContain(ACCOUNT_MENU_ATTR);
  });

  it('escapes a hostile org, project and host', () => {
    const html = accountControlHtml(
      { signedIn: true, org: '<img src=x onerror=alert(1)>', host: '<script>' },
      { projectName: '<b>p</b>' },
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>p</b>');
  });

  it('refuses a javascript: dashboard url, and offers the link hint instead', () => {
    const html = accountControlHtml(SIGNED_IN, { dashboardUrl: 'javascript:alert(1)' });
    expect(html).not.toContain('javascript:');
    expect(html).toContain(ACCOUNT_TEXT.LINK_COMMAND);
  });
});

describe('opening and closing the menu', () => {
  it('starts shut, to both the eye and a screen reader', () => {
    const { root, teardown } = mounted(accountControlHtml(SIGNED_IN, { dashboardUrl: DASHBOARD }));
    expect(menu(root)?.hasAttribute('hidden')).toBe(true);
    expect(menu(root)?.getAttribute('aria-hidden')).toBe('true');
    expect(trigger(root)?.getAttribute('aria-expanded')).toBe('false');
    teardown();
    root.remove();
  });

  it('opens on the trigger and closes on a second click', () => {
    const { root, teardown } = mounted(accountControlHtml(SIGNED_IN, { dashboardUrl: DASHBOARD }));
    trigger(root)?.click();
    expect(menu(root)?.hasAttribute('hidden')).toBe(false);
    expect(menu(root)?.getAttribute('aria-hidden')).toBe('false');
    expect(trigger(root)?.getAttribute('aria-expanded')).toBe('true');
    trigger(root)?.click();
    expect(menu(root)?.hasAttribute('hidden')).toBe(true);
    teardown();
    root.remove();
  });

  it('closes on a click outside the HUD', () => {
    const { root, teardown } = mounted(accountControlHtml(SIGNED_IN, { dashboardUrl: DASHBOARD }));
    trigger(root)?.click();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(menu(root)?.hasAttribute('hidden')).toBe(true);
    teardown();
    root.remove();
  });

  it('closes on Escape', () => {
    const { root, teardown } = mounted(accountControlHtml(SIGNED_IN, { dashboardUrl: DASHBOARD }));
    trigger(root)?.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu(root)?.hasAttribute('hidden')).toBe(true);
    teardown();
    root.remove();
  });

  it('stops listening after teardown, so a torn-down HUD cannot reopen', () => {
    const { root, teardown } = mounted(accountControlHtml(SIGNED_IN, { dashboardUrl: DASHBOARD }));
    teardown();
    trigger(root)?.click();
    expect(menu(root)?.hasAttribute('hidden')).toBe(true);
    root.remove();
  });

  /* Sign out is a terminal step for the same reason sign in is: only the CLI writes ~/.reticle. */
  it('copies the sign-out command rather than pretending to sign you out', () => {
    const { root, teardown } = mounted(accountControlHtml(SIGNED_IN, { dashboardUrl: DASHBOARD }));
    const out = root.querySelector(`[${ACCOUNT_SIGNOUT_ATTR}]`);
    expect(out?.getAttribute('data-reticle-copy')).toBe(ACCOUNT_TEXT.SIGNOUT_COMMAND);
    teardown();
    root.remove();
  });
});
