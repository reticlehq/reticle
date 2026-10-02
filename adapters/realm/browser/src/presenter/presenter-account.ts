/**
 * Whether this machine is signed in, said the same way in every panel that shows it.
 *
 * One builder rather than three, because the interesting part is not the markup — it is the RULE,
 * and a rule copied into three panels is a rule that will be right in two of them.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────────
 * THREE states, not two. `signedIn: true`, `signedIn: false`, and ABSENT — which means UNKNOWN and
 * renders nothing at all. An older daemon sends no `account` field, and a panel that read absence as
 * "signed out" would show a paying user a Sign in button on every panel they open. That is the kind
 * of nag that gets a dev-only HUD switched off for good, and switching it off costs them every
 * verdict, not just the button. `core/src/artifacts/impact.ts` states this where the field is
 * declared; this is where it has to be obeyed.
 *
 * ── NO IDENTITY BEYOND THE ORG ──────────────────────────────────────────────────────────────────
 * The avatar is built from `org`, because `org` is all there is. `AccountState` carries
 * `{ signedIn, org?, host? }` and deliberately no name, no email and no token: it is pushed into the
 * DOM of the user's own app, where anything else running on that page can read it. Initials of a
 * PERSON would mean putting a person's name there, and a nicer avatar is not worth adding the first
 * leakable field to a payload that currently has none.
 *
 * ── WHY SIGN IN IS NOT A BUTTON THAT SIGNS YOU IN ───────────────────────────────────────────────
 * A page cannot run a CLI, and signing in is a device flow in a terminal. So the control copies
 * `reticle login` rather than pretending to start something. A button that quietly does nothing is
 * worse than a line of text, because the person waits for it.
 */

import type { AccountState } from '@reticlehq/core';
import { hiIconHtml, PRESENTER_ICON_SIZE, PresenterIcon } from './icons/presenter-icons.js';
import { esc, isSafeDashboardUrl } from './chrome/presenter-safe-html.js';

/** Behaviour hooks. Attributes rather than classes: a class is styling, these are wiring. */
export const ACCOUNT_ROOT_ATTR = 'data-reticle-account';
export const ACCOUNT_SIGNIN_ATTR = 'data-reticle-account-signin';
export const SYNC_BTN_ATTR = 'data-reticle-sync-now';
/** The clickable trigger, and the menu it owns. */
export const ACCOUNT_TRIGGER_ATTR = 'data-reticle-account-trigger';
export const ACCOUNT_MENU_ATTR = 'data-reticle-account-menu';
export const ACCOUNT_SIGNOUT_ATTR = 'data-reticle-account-signout';

export const ACCOUNT_TEXT = {
  SIGNED_OUT: 'Sign in',
  SIGNIN_TITLE: 'Run `reticle login` in your terminal — click to copy the command',
  SIGNIN_COMMAND: 'reticle login',
  DASHBOARD_TITLE: 'Open this project on the dashboard',
  /** "Now", not "sync" — the timer already syncs, this only stops somebody wondering when. */
  SYNC_TITLE: 'Push to the dashboard now, instead of waiting for the next sync',
  COPIED: 'Copied',
  /** Shown as the avatar when signed in to an org with no printable name. */
  AVATAR_FALLBACK: '•',
  MENU_LABEL: 'Reticle account',
  TRIGGER_TITLE: 'Your Reticle account',
  SIGNED_IN_AS: 'Signed in',
  DASHBOARD_ACTION: 'Open dashboard',
  /** Linking is a terminal step for the same reason signing in is: only the CLI can write the file. */
  LINK_HINT: 'Not linked — run `reticle link` to keep a record on the dashboard',
  LINK_COMMAND: 'reticle link',
  SIGNOUT_ACTION: 'Sign out',
  SIGNOUT_TITLE: 'Run `reticle logout` in your terminal — click to copy the command',
  SIGNOUT_COMMAND: 'reticle logout',
  PROJECT_LABEL: 'Project',
  HOST_LABEL: 'Host',
  VERDICTS_LABEL: 'Verdicts',
  DEFECTS_LABEL: 'Defects found',
} as const;

/** How long the "Copied" label stays before the control says its own name again. */
const ACCOUNT_COPIED_MS = 1200;

/** What the menu reports about this project, beyond who is signed in. */
export interface AccountDetails {
  projectName?: string | undefined;
  dashboardUrl?: string | undefined;
  verdicts?: number | undefined;
  defects?: number | undefined;
}

/**
 * One or two letters for the avatar.
 *
 * Two words give two initials, one word gives one letter, and anything with no printable character
 * falls back to a dot — an avatar with no glyph reads as a broken image, which is worse than a plain
 * one. Upper-cased because an avatar is a mark, not a quotation.
 */
export function accountInitials(org: string | undefined): string {
  const words = (org ?? '')
    .trim()
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0);
  const letters = words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('');
  return letters.length > 0 ? letters.toUpperCase() : ACCOUNT_TEXT.AVATAR_FALLBACK;
}

/**
 * The account control: one trigger, one menu, the same markup on every surface that shows it.
 *
 * THREE STATES, and the third is the one that matters. `signedIn: true`, `signedIn: false`, and
 * ABSENT -- which means UNKNOWN and renders nothing at all. An older daemon sends no `account` field,
 * and a surface that read absence as "signed out" would offer a paying user a Sign in button on every
 * panel they open.
 *
 * ONE BUILDER, THREE MOUNTS. The header, the settings panel and the impact report all call this, and
 * they used to each style their own copy: three `.reticle-account` blocks that had drifted to
 * `gap:4px`, `gap:6px` and `display:flex`, so the same control looked like three controls. The rules
 * now live once, unscoped, in `presenter-account-styles.ts`.
 *
 * WHAT THE MENU IS FOR. An avatar alone answers "am I signed in" and nothing else. Somebody who has
 * just run `reticle login` wants to know WHICH account, on WHICH host, against WHICH project, and
 * where the record went -- so the menu carries the identity, the project, the counts already on the
 * wire, and the way through to the dashboard. Everything in it comes from the impact snapshot; none
 * of it is fetched, because the HUD has no credential and must never acquire one.
 *
 * `offerSignIn` decides whether a surface may ASK. Off by default: the report panel already tells an
 * unlinked user where their record stops, once, and its own tests call a second mention in the same
 * panel a nag. Persistent chrome is the exception -- a capsule in the header is answering a question
 * the user can see, not interrupting them.
 */
export function accountControlHtml(
  account: AccountState | undefined,
  details: AccountDetails = {},
  offerSignIn = false,
): string {
  if (account === undefined) return '';
  if (!account.signedIn) {
    if (!offerSignIn) return '';
    return `<div class="reticle-account" ${ACCOUNT_ROOT_ATTR}><button type="button" class="reticle-account-signin" ${ACCOUNT_SIGNIN_ATTR} title="${ACCOUNT_TEXT.SIGNIN_TITLE}" aria-label="${ACCOUNT_TEXT.SIGNIN_TITLE}">${ACCOUNT_TEXT.SIGNED_OUT}</button></div>`;
  }
  const org = account.org ?? '';
  // The org's name is the avatar's accessible label: a screen reader announcing "AC" has said
  // nothing, and the two letters exist only because a circle needs something drawn in it.
  const label = org.length > 0 ? esc(org) : ACCOUNT_TEXT.SIGNED_IN_AS;
  const avatar = `<span class="reticle-account-avatar" aria-hidden="true">${esc(accountInitials(account.org))}</span>`;
  const trigger =
    `<button type="button" class="reticle-account-trigger" ${ACCOUNT_TRIGGER_ATTR}` +
    ` aria-haspopup="true" aria-expanded="false" title="${ACCOUNT_TEXT.TRIGGER_TITLE}"` +
    ` aria-label="${ACCOUNT_TEXT.TRIGGER_TITLE}: ${label}">${avatar}</button>`;
  return `<div class="reticle-account" ${ACCOUNT_ROOT_ATTR}>${trigger}${accountMenuHtml(account, details)}</div>`;
}

/** One `k: v` row, or nothing when there is no value — an empty row states a fact it does not have. */
function detailRow(key: string, value: string | undefined): string {
  if (value === undefined || 0 === value.length) return '';
  return `<div class="reticle-account-row"><span class="reticle-account-k">${esc(key)}</span><span class="reticle-account-v" title="${esc(value)}">${esc(value)}</span></div>`;
}

/**
 * The menu: who, where, and what has happened here.
 *
 * Hidden by BOTH `hidden` and `aria-hidden`, because the two are read by different things and a menu
 * that is invisible to the eye and present to a screen reader is a worse bug than one that is simply
 * shut.
 *
 * The email line is rendered only when the daemon actually sent one, which no cloud does yet. It sits
 * in here rather than on the trigger deliberately: the trigger is always in the page, and a personal
 * address belongs behind a click even on a dev-only overlay.
 */
function accountMenuHtml(account: AccountState, details: AccountDetails): string {
  const org = account.org ?? '';
  const identity =
    `<div class="reticle-account-head">` +
    `<span class="reticle-account-avatar reticle-account-avatar--lg" aria-hidden="true">${esc(accountInitials(account.org))}</span>` +
    `<span class="reticle-account-who">` +
    `<span class="reticle-account-org">${org.length > 0 ? esc(org) : ACCOUNT_TEXT.SIGNED_IN_AS}</span>` +
    (account.email !== undefined && account.email.length > 0
      ? `<span class="reticle-account-email" title="${esc(account.email)}">${esc(account.email)}</span>`
      : `<span class="reticle-account-email">${ACCOUNT_TEXT.SIGNED_IN_AS}</span>`) +
    `</span></div>`;

  const rows =
    detailRow(ACCOUNT_TEXT.HOST_LABEL, account.host) +
    detailRow(ACCOUNT_TEXT.PROJECT_LABEL, details.projectName) +
    detailRow(
      ACCOUNT_TEXT.VERDICTS_LABEL,
      details.verdicts !== undefined ? String(details.verdicts) : undefined,
    ) +
    detailRow(
      ACCOUNT_TEXT.DEFECTS_LABEL,
      details.defects !== undefined ? String(details.defects) : undefined,
    );

  const linked = details.dashboardUrl !== undefined && isSafeDashboardUrl(details.dashboardUrl);
  const dashboard = linked
    ? `<a class="reticle-account-action" data-reticle-account-dashboard href="${esc(details.dashboardUrl ?? '')}" target="_blank" rel="noreferrer noopener" title="${ACCOUNT_TEXT.DASHBOARD_TITLE}">${hiIconHtml(PresenterIcon.VIEW, PRESENTER_ICON_SIZE.HELP)}<span>${ACCOUNT_TEXT.DASHBOARD_ACTION}</span></a>`
    : // Unlinked is a real and common state -- an account with a repo nobody has run `reticle link`
      // in -- and it gets the way forward rather than a link that 404s.
      `<button type="button" class="reticle-account-action reticle-account-action--hint" ${ACCOUNT_SIGNIN_ATTR} data-reticle-copy="${ACCOUNT_TEXT.LINK_COMMAND}" title="${ACCOUNT_TEXT.LINK_HINT}"><span>${ACCOUNT_TEXT.LINK_HINT}</span></button>`;
  const signOut = `<button type="button" class="reticle-account-action" ${ACCOUNT_SIGNOUT_ATTR} data-reticle-copy="${ACCOUNT_TEXT.SIGNOUT_COMMAND}" title="${ACCOUNT_TEXT.SIGNOUT_TITLE}"><span>${ACCOUNT_TEXT.SIGNOUT_ACTION}</span></button>`;

  return (
    `<div class="reticle-account-menu" ${ACCOUNT_MENU_ATTR} role="menu" aria-label="${ACCOUNT_TEXT.MENU_LABEL}" aria-hidden="true" hidden>` +
    identity +
    (rows.length > 0 ? `<div class="reticle-account-rows">${rows}</div>` : '') +
    `<div class="reticle-account-actions">${dashboard}${signOut}</div>` +
    `</div>`
  );
}

/**
 * Kept as the old name, because three surfaces and their tests call it.
 *
 * @deprecated Use `accountControlHtml`, which takes the details the menu shows.
 */
export function accountCapsuleHtml(
  account: AccountState | undefined,
  dashboardUrl?: string,
  offerSignIn = false,
): string {
  return accountControlHtml(account, { dashboardUrl }, offerSignIn);
}

/**
 * The sync button, for a panel that shows a record worth pushing.
 *
 * Only when LINKED. Unlinked there is nowhere to push, and a button that reports success having
 * sent nothing is the false green this product exists to refuse — in miniature, on its own HUD.
 */
export function syncButtonHtml(dashboardUrl: string | undefined): string {
  if (dashboardUrl === undefined || !isSafeDashboardUrl(dashboardUrl)) return '';
  return `<button type="button" class="reticle-sync-now" ${SYNC_BTN_ATTR} title="${ACCOUNT_TEXT.SYNC_TITLE}" aria-label="${ACCOUNT_TEXT.SYNC_TITLE}">${hiIconHtml(PresenterIcon.SYNC, PRESENTER_ICON_SIZE.HELP)}</button>`;
}

/**
 * Wire every account control under `root`: open the menu, close it, copy a command.
 *
 * ONE listener set for all three surfaces, delegated from `root`, because the markup is re-rendered
 * on every snapshot push. A listener bound to a button would be bound to a button that no longer
 * exists the next time the daemon reports anything, which is the defect that makes a re-rendered
 * control feel broken rather than look broken.
 *
 * Returns its own teardown. The caller owns an `AbortController` for everything else, and this hands
 * back a function rather than taking a signal so it can be called from a panel that has none.
 */
export function mountAccountControl(root: HTMLElement): () => void {
  const controller = new AbortController();
  const { signal } = controller;

  const closeAll = (except?: Element): void => {
    for (const menu of root.querySelectorAll(`[${ACCOUNT_MENU_ATTR}]`)) {
      if (menu === except) continue;
      menu.setAttribute('hidden', '');
      menu.setAttribute('aria-hidden', 'true');
    }
    for (const trigger of root.querySelectorAll(`[${ACCOUNT_TRIGGER_ATTR}]`)) {
      if (except !== undefined && trigger.parentElement === except.parentElement) continue;
      trigger.setAttribute('aria-expanded', 'false');
    }
  };

  /** Flash the control's own label, so the feedback is where the click was. */
  const flashCopied = (el: HTMLElement): void => {
    const label = el.querySelector('span') ?? el;
    const previous = label.textContent;
    label.textContent = ACCOUNT_TEXT.COPIED;
    setTimeout(() => {
      label.textContent = previous;
    }, ACCOUNT_COPIED_MS);
  };

  root.addEventListener(
    'click',
    (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const trigger = target.closest(`[${ACCOUNT_TRIGGER_ATTR}]`);
      if (trigger instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        const menu = trigger.parentElement?.querySelector(`[${ACCOUNT_MENU_ATTR}]`);
        if (!(menu instanceof HTMLElement)) return;
        const wasOpen = !menu.hasAttribute('hidden');
        closeAll();
        if (wasOpen) return;
        menu.removeAttribute('hidden');
        menu.setAttribute('aria-hidden', 'false');
        trigger.setAttribute('aria-expanded', 'true');
        return;
      }

      // Every command this menu names is a TERMINAL step -- login, link and logout all write to
      // `~/.reticle`, which a page cannot do. So the control copies the command rather than
      // pretending to start it: a button that quietly does nothing is worse than a line of text,
      // because the person waits for it.
      const copier = target.closest('[data-reticle-copy]');
      if (copier instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        const command = copier.getAttribute('data-reticle-copy') ?? '';
        if (command.length > 0) void navigator.clipboard?.writeText(command).catch(() => undefined);
        flashCopied(copier);
        return;
      }

      // The bare Sign in control carries no `data-reticle-copy`, because it predates the menu and
      // three surfaces plus their tests assert on its attribute.
      const signin = target.closest(`[${ACCOUNT_SIGNIN_ATTR}]`);
      if (signin instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard?.writeText(ACCOUNT_TEXT.SIGNIN_COMMAND).catch(() => undefined);
        flashCopied(signin);
        return;
      }

      // A click anywhere else inside the HUD, including on another panel, shuts an open menu.
      closeAll();
    },
    { signal },
  );

  // On `document`, not `root`: a click on the page outside the HUD must close it too, and the HUD
  // does not receive that event.
  document.addEventListener(
    'pointerdown',
    (event: Event) => {
      const target = event.target;
      if (target instanceof Node && root.contains(target)) return;
      closeAll();
    },
    { signal },
  );

  document.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if ('Escape' !== event.key) return;
      const open = root.querySelector(`[${ACCOUNT_MENU_ATTR}]:not([hidden])`);
      if (null === open) return;
      // Only when a menu is actually open, so Escape keeps its other meanings in the HUD.
      event.stopPropagation();
      closeAll();
    },
    { signal },
  );

  return () => controller.abort();
}
