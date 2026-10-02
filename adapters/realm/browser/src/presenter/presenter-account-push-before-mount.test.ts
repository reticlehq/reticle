/**
 * An account push that arrives BEFORE the shell mounts must still reach the DOM.
 *
 * The daemon pushes the impact snapshot immediately when a session connects, which races the HUD's
 * mount. `paintAccount` cannot paint before mount, and a dropped paint used to be repaired only by
 * the NEXT snapshot — which an idle page never receives, because a snapshot is pushed by a tool call.
 *
 * Measured on the bench app before the fix: the account reached the page on 6 of 6 loads and reached
 * the DOM on 2 of 6, so a signed-in user saw an empty capsule roughly two times in three.
 */

import { describe, expect, it } from 'vitest';
import type { AccountState } from '@reticlehq/core';
import { HudShell } from './presenter-shell.js';

const SIGNED_IN: AccountState = { signedIn: true, org: 'Drive Platform Co' };
const DASHBOARD = 'https://app.reticle.sh/p/acme';

function dockRoot(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = HudShell.dockHtml('', '', 'data-reticle-log', '', '');
  document.body.appendChild(root);
  return root;
}

const accountEls = (root: HTMLElement): NodeListOf<Element> =>
  root.querySelectorAll('[data-reticle-account]');

describe('an account push that beats the mount', () => {
  it('lands in the DOM once the shell mounts', () => {
    const shell = new HudShell({});
    const root = dockRoot();

    // The push arrives first — this is the race, not a contrived ordering.
    shell.paintAccount(SIGNED_IN, DASHBOARD);
    expect(accountEls(root).length, 'nothing can be painted before a root exists').toBe(0);

    shell.mount(root);
    expect(
      accountEls(root).length,
      'the push was dropped and never replayed — the capsule stays empty for the whole session',
    ).toBeGreaterThan(0);
    expect(root.textContent).toContain('DP');
    shell.teardown();
    root.remove();
  });

  it('still paints when the push arrives after the mount', () => {
    const shell = new HudShell({});
    const root = dockRoot();
    shell.mount(root);
    shell.paintAccount(SIGNED_IN, DASHBOARD);
    expect(accountEls(root).length).toBeGreaterThan(0);
    shell.teardown();
    root.remove();
  });

  it('replays a SIGNED-OUT push too, rather than only the flattering one', () => {
    const shell = new HudShell({});
    const root = dockRoot();
    shell.paintAccount({ signedIn: false }, undefined);
    shell.mount(root);
    expect(root.querySelectorAll('[data-reticle-account-signin]').length).toBeGreaterThan(0);
    shell.teardown();
    root.remove();
  });

  it('paints nothing when no push ever arrived — absent stays UNKNOWN', () => {
    const shell = new HudShell({});
    const root = dockRoot();
    shell.mount(root);
    expect(accountEls(root).length, 'a mount must not invent an account nobody sent').toBe(0);
    shell.teardown();
    root.remove();
  });
});

/**
 * Where the capsule lives, asserted structurally.
 *
 * It used to sit in the workspace menu's head, inside `.reticle-workspace-wrap` — a wrapper that
 * hides itself when neither a repo root nor a leased project id is known. Account state has nothing
 * to do with whether the checkout is identifiable, so on any app injecting neither, a signed-in user
 * could not see that they were signed in. It is not in the toolbar either: that row was already 13px
 * wider than itself, and a 20px avatar there pushed the close button outside the panel.
 */
describe('where the account capsule lives', () => {
  it('is not inside the self-hiding workspace wrapper', () => {
    const root = dockRoot();
    const slot = root.querySelector('[data-reticle-toolbar-account]');
    expect(slot, 'the slot must exist in the dock markup').not.toBeNull();
    expect(
      slot?.closest('.reticle-workspace-wrap'),
      'a capsule in here is invisible whenever the workspace is unidentifiable',
    ).toBeNull();
    root.remove();
  });

  it('sits in the header row, which is visible whenever the panel is', () => {
    const root = dockRoot();
    const slot = root.querySelector('[data-reticle-toolbar-account]');
    expect(
      slot?.closest('.reticle-chat-head'),
      'the header is the always-visible row',
    ).not.toBeNull();
    root.remove();
  });

  it('does not add a fourth group to the toolbar, which has no room for one', () => {
    const root = dockRoot();
    const toolbar = root.querySelector('.reticle-toolbar');
    expect(toolbar?.querySelector('[data-reticle-toolbar-account]')).toBeNull();
    root.remove();
  });
});
