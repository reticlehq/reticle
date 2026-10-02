/**
 * The account capsule, and mostly the one rule it exists to keep: absent is UNKNOWN, never
 * signed-out.
 *
 * That rule is why this is a shared builder at all. Three panels now show account state, and the
 * failure it prevents — a Sign in button shown to somebody who is already signed in, on every panel
 * they open — is not a cosmetic bug: a dev-only HUD that nags gets switched off, and switching it
 * off costs the user every verdict rather than just the button.
 */

import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_SIGNIN_ATTR,
  ACCOUNT_TEXT,
  SYNC_BTN_ATTR,
  accountCapsuleHtml,
  accountInitials,
  syncButtonHtml,
} from './presenter-account.js';

const DASHBOARD = 'https://app.reticle.sh/p/acme';

describe('the three states of the account capsule', () => {
  it('renders NOTHING when the daemon sent no account — absence is unknown', () => {
    expect(accountCapsuleHtml(undefined, DASHBOARD)).toBe('');
  });

  /*
   * Signed out says NOTHING unless the surface asked to offer sign-in, and the default is silence.
   *
   * The report panel already tells an unlinked user where their record stops — once, and only after
   * a verdict has made that worth saying. Its own tests call a second mention in the same panel
   * "where a line becomes a nag". A capsule that offered Sign in by default broke both of those
   * rules the moment it was added to that panel, and those two tests caught it.
   */
  it('says nothing when signed out, unless the surface asked to offer it', () => {
    expect(accountCapsuleHtml({ signedIn: false })).toBe('');
  });

  it('offers Sign in on persistent chrome, which asked for it', () => {
    const html = accountCapsuleHtml({ signedIn: false }, undefined, true);
    expect(html).toContain(ACCOUNT_SIGNIN_ATTR);
    expect(html).toContain(ACCOUNT_TEXT.SIGNED_OUT);
  });

  it('stays silent on UNKNOWN even where sign-in is offered', () => {
    expect(accountCapsuleHtml(undefined, undefined, true)).toBe('');
  });

  it('shows an avatar and no Sign in when signed in', () => {
    const html = accountCapsuleHtml({ signedIn: true, org: 'Acme Corp' }, DASHBOARD);
    expect(html).toContain('reticle-account-avatar');
    expect(html).toContain('AC');
    expect(html, 'a signed-in user must never be asked to sign in').not.toContain(
      ACCOUNT_SIGNIN_ATTR,
    );
  });

  it('announces the org, because two letters announce nothing to a screen reader', () => {
    // On the TRIGGER rather than the avatar: the avatar is a decorative glyph inside a button, and
    // the accessible name belongs on the thing that takes the click.
    const html = accountCapsuleHtml({ signedIn: true, org: 'Acme Corp' });
    expect(html).toContain('Acme Corp');
    expect(html, 'the org must reach a screen reader as a label, not only as drawn text').toMatch(
      /aria-label="[^"]*Acme Corp/,
    );
    expect(
      html,
      'the two drawn letters must be hidden, or a reader announces "AC" as well',
    ).toContain('aria-hidden="true"');
  });
});

describe('the dashboard link', () => {
  it('is present when signed in AND linked', () => {
    expect(accountCapsuleHtml({ signedIn: true, org: 'Acme' }, DASHBOARD)).toContain(DASHBOARD);
  });

  it('is absent when signed in and the repo is NOT linked — a common, valid state', () => {
    const html = accountCapsuleHtml({ signedIn: true, org: 'Acme' });
    expect(html).toContain('reticle-account-avatar');
    expect(html, 'a link to a project that is not linked would 404').not.toContain('<a ');
  });

  /*
   * The recorded incident, re-asserted from the second caller.
   *
   * The url comes from `.reticle/cloud.json`, a file in somebody's repository, so it is INPUT — and
   * `javascript:` once produced a link that ran code inside the developer's own application from a
   * panel Reticle injected there. `presenter-safe-html.ts` holds the rule; this is the capsule
   * proving it obeys it rather than trusting that it does.
   */
  it('refuses a javascript: url rather than rendering a link', () => {
    const html = accountCapsuleHtml({ signedIn: true, org: 'Acme' }, 'javascript:alert(1)');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
  });

  it('escapes an org name that contains markup', () => {
    const html = accountCapsuleHtml({ signedIn: true, org: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('avatar initials', () => {
  it('takes two initials from two words', () => {
    expect(accountInitials('Acme Corp')).toBe('AC');
  });

  it('takes one letter from one word', () => {
    expect(accountInitials('acme')).toBe('A');
  });

  it('splits on punctuation a slug uses', () => {
    expect(accountInitials('acme-corp')).toBe('AC');
    expect(accountInitials('acme_corp')).toBe('AC');
  });

  it('falls back to a glyph rather than an empty circle', () => {
    expect(accountInitials(undefined)).toBe(ACCOUNT_TEXT.AVATAR_FALLBACK);
    expect(accountInitials('   ')).toBe(ACCOUNT_TEXT.AVATAR_FALLBACK);
  });

  it('does not split a name into bytes — one emoji is one initial', () => {
    expect(accountInitials('🚀 Labs')).toBe('🚀L');
  });
});

describe('the sync button', () => {
  it('is present for a linked project', () => {
    expect(syncButtonHtml(DASHBOARD)).toContain(SYNC_BTN_ATTR);
  });

  /*
   * Unlinked there is nowhere to push, and a button that reports success having sent nothing is the
   * false green this product exists to refuse — in miniature, on its own HUD.
   */
  it('is absent for a project with nowhere to push', () => {
    expect(syncButtonHtml(undefined)).toBe('');
    expect(syncButtonHtml('javascript:alert(1)')).toBe('');
  });
});
