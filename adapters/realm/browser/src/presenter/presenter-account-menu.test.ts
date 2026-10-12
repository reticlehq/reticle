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
  paintAccountSlot,
  platformDetails,
  teamLinkHtml,
  TEAM_OPEN_ATTR,
  TEAM_TEXT,
  ACCOUNT_SIGNIN_ATTR as ACCOUNT_SIGNIN_ATTR_NAME,
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
    expect(out?.textContent).toContain('Copy sign-out command');
    teardown();
    root.remove();
  });

  it('confirms when the sign-out command reaches the clipboard', async () => {
    const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          expect(text).toBe(ACCOUNT_TEXT.SIGNOUT_COMMAND);
          return Promise.resolve();
        },
      },
    });
    const { root, teardown } = mounted(accountControlHtml(SIGNED_IN, {}));
    const out = root.querySelector<HTMLElement>(`[${ACCOUNT_SIGNOUT_ATTR}]`);
    out?.click();
    await Promise.resolve();
    expect(out?.textContent).toBe(ACCOUNT_TEXT.COPIED);
    teardown();
    root.remove();
    if (prior === undefined) Reflect.deleteProperty(navigator, 'clipboard');
    else Object.defineProperty(navigator, 'clipboard', prior);
  });

  it('explains the terminal command if the clipboard is unavailable', async () => {
    const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { root, teardown } = mounted(accountControlHtml(SIGNED_IN, {}));
    const out = root.querySelector<HTMLElement>(`[${ACCOUNT_SIGNOUT_ATTR}]`);
    out?.click();
    await Promise.resolve();
    expect(out?.textContent).toBe(ACCOUNT_TEXT.SIGNOUT_COPY_FAILED);
    teardown();
    root.remove();
    if (prior === undefined) Reflect.deleteProperty(navigator, 'clipboard');
    else Object.defineProperty(navigator, 'clipboard', prior);
  });
});

/**
 * Sign in used to copy `reticle connect` and stop: a dead end for anybody who does not live in a
 * terminal. It now asks the daemon to open the browser approval, and still copies the command as
 * the fallback for an older daemon that does not answer.
 */
describe('signing in from the HUD', () => {
  it('asks the daemon to start the browser sign-in', () => {
    const root = document.createElement('div');
    root.innerHTML = accountControlHtml({ signedIn: false }, {}, true);
    document.body.appendChild(root);
    let asked = 0;
    const teardown = mountAccountControl(root, () => {
      asked += 1;
    });
    root.querySelector<HTMLElement>('[data-reticle-account-signin]')?.click();
    expect(asked).toBe(1);
    teardown();
    root.remove();
  });

  it('does not treat the copy-a-command hints as a sign-in', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<button data-reticle-account-signin data-reticle-copy="reticle connect">link</button>';
    document.body.appendChild(root);
    let asked = 0;
    const teardown = mountAccountControl(root, () => {
      asked += 1;
    });
    root.querySelector<HTMLElement>('button')?.click();
    expect(asked).toBe(0);
    teardown();
    root.remove();
  });
});

describe('the platform, as the daemon last read it', () => {
  it('says the plan, the credits, the Harness runs and the memory when the platform sent them', () => {
    const html = accountControlHtml(SIGNED_IN, {
      dashboardUrl: DASHBOARD,
      plan: 'Trial · 9 days left',
      credits: '380 of 500 trial credits',
      harnessRuns: '12',
      memory: '48 entries',
    });
    for (const text of [
      ACCOUNT_TEXT.PLAN_LABEL,
      'Trial · 9 days left',
      ACCOUNT_TEXT.CREDITS_LABEL,
      '380 of 500 trial credits',
      ACCOUNT_TEXT.HARNESS_RUNS_LABEL,
      ACCOUNT_TEXT.MEMORY_LABEL,
      '48 entries',
    ])
      expect(html).toContain(text);
  });

  it('says nothing about them when the platform did not', () => {
    const html = accountControlHtml(SIGNED_IN, { dashboardUrl: DASHBOARD });
    for (const label of [
      ACCOUNT_TEXT.PLAN_LABEL,
      ACCOUNT_TEXT.CREDITS_LABEL,
      ACCOUNT_TEXT.HARNESS_RUNS_LABEL,
      ACCOUNT_TEXT.MEMORY_LABEL,
    ])
      expect(html).not.toContain(label);
  });

  it('does not say "Signed in" twice when there is no email', () => {
    const html = accountControlHtml({ signedIn: true }, {});
    expect(html.split(ACCOUNT_TEXT.SIGNED_IN_AS).length - 1).toBe(2); // trigger label + menu head
  });

  it('a repaint keeps an open menu open and the trigger the same element', () => {
    const { root, teardown } = mounted('<div data-slot></div>');
    const slot = root.querySelector<HTMLElement>('[data-slot]');
    if (null === slot) throw new Error('no slot');
    paintAccountSlot(slot, accountControlHtml(SIGNED_IN, { verdicts: 1 }));
    const before = trigger(root);
    before?.click();
    expect(menu(root)?.hidden).toBe(false);
    paintAccountSlot(slot, accountControlHtml(SIGNED_IN, { verdicts: 2 }));
    expect(trigger(root)).toBe(before);
    expect(menu(root)?.hidden).toBe(false);
    expect(trigger(root)?.getAttribute('aria-expanded')).toBe('true');
    expect(menu(root)?.textContent).toContain('2');
    teardown();
    root.remove();
  });
});

describe('platformDetails', () => {
  it('words the plan, credits, runs and memory from the snapshot', () => {
    expect(
      platformDetails(
        {
          provider: 'jev',
          harnessEnabled: true,
          harnessEntitled: true,
          credits: { used: 120, limit: 500, kind: 'trial' },
          plan: { kind: 'trial', daysLeft: 9, seats: 3 },
          harnessRuns: 12,
          memoryEntries: 1,
        },
        { onPlatform: 4 },
      ),
    ).toEqual({
      plan: 'Trial · 9 days left · 3 seats',
      credits: '380 of 500 left',
      harnessRuns: '12',
      memory: '1 entry',
      onPlatform: '4',
    });
  });

  it('is empty when the platform said nothing', () => {
    expect(platformDetails(undefined, undefined)).toEqual({});
  });
});

describe('the header’s way to the platform', () => {
  it('opens the dashboard once linked', () => {
    const html = teamLinkHtml(SIGNED_IN, DASHBOARD);
    expect(html).toContain(TEAM_TEXT.OPEN);
    expect(html).toContain(`href="${DASHBOARD}"`);
    expect(html).toContain(TEAM_OPEN_ATTR);
  });

  it('offers to save runs for the team, with the real trial, before it is linked', () => {
    const unlinked = teamLinkHtml(SIGNED_IN, undefined);
    expect(unlinked).toContain(TEAM_TEXT.SAVE_LINK);
    expect(unlinked).toContain('500 Harness credits');
    expect(unlinked).not.toContain(ACCOUNT_SIGNIN_ATTR_NAME);
    expect(unlinked).not.toMatch(/3 months|three months|UNICORN/i);
  });

  /** Signed out, the HUD asked three times at once; the rail under every page is the one ask. */
  it('is not a second sign-in ask when signed out', () => {
    expect(teamLinkHtml({ signedIn: false }, undefined)).toBe('');
  });

  it('says nothing while the account is unknown', () => {
    expect(teamLinkHtml(undefined, DASHBOARD)).toBe('');
  });
});
