/**
 * A HUD the agent minimised stays minimised across a reload.
 *
 * Field reports, from drivers OUTSIDE Reticle: "Reticle presenter expands on full reload and
 * intercepts app Refresh locations click; preserve minimized state across reloads", and
 * "Reticle expanded chat/log overlay intercepted Playwright click on + New task". The pattern in
 * each is the same: minimise our panel to reach the app, reload the page, and it is back over the
 * control - so the next click lands on Reticle instead of the product and times out.
 *
 * `autoOpenChat` is a PREFERENCE (should the chat appear at session start with no click) and stays
 * one. This is a different question: somebody has already answered it for this tab, by hand, and a
 * reload is not them changing their mind. Per-tab rather than a saved preference, because minimising
 * to get at one control is not a decision about every future session.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  HudShell,
  rememberMinimised,
  shouldAutoOpenChat,
  wasMinimised,
} from './presenter-shell.js';
import { CHAT_ATTR, MIN_ATTR } from './presenter-config.js';

describe('the minimised HUD survives a reload', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('does not claim a minimised HUD before anybody minimised one', () => {
    expect(wasMinimised()).toBe(false);
  });

  it('remembers a minimise, which is what a reload reads', () => {
    rememberMinimised(true);
    expect(wasMinimised()).toBe(true);
  });

  it('forgets it the moment the HUD is expanded again', () => {
    rememberMinimised(true);
    rememberMinimised(false);
    expect(wasMinimised()).toBe(false);
  });

  /*
   * A page that refuses storage must still get a HUD. Private browsing, a blocked-cookies profile
   * and a sandboxed iframe all throw on access rather than returning null, and a dev overlay that
   * cannot remember a preference is a much smaller problem than one that throws into the app's own
   * load path.
   */
  it('never throws when the page refuses storage', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage is disabled');
      },
    });
    try {
      expect(() => rememberMinimised(true)).not.toThrow();
      expect(wasMinimised()).toBe(false);
    } finally {
      if (real !== undefined) Object.defineProperty(globalThis, 'sessionStorage', real);
    }
  });
});

/**
 * The end-to-end property, not just the storage behind it.
 *
 * A module test proves a key round-trips. What the field reported is that the PANEL comes back, so
 * the panel is what this drives: collapse it, throw the whole shell away the way a reload does, mount
 * a fresh one, and it must still be collapsed with the chat shut.
 */
describe('a reload does not undo the minimise', () => {
  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '';
  });

  const mountShell = (): { shell: HudShell; root: HTMLElement } => {
    const shell = new HudShell({});
    const root = document.createElement('div');
    root.innerHTML = HudShell.dockHtml('', '', 'data-reticle-log', '', '');
    document.body.appendChild(root);
    shell.mount(root);
    return { shell, root };
  };

  it('a minimise outlives the shell that recorded it', () => {
    const first = mountShell();
    first.shell.openChat();
    expect(first.root.querySelector(`[${MIN_ATTR}]`) ?? first.root).toBeTruthy();
    first.shell.collapse();
    expect(wasMinimised(), 'the collapse was not recorded, so a reload cannot honour it').toBe(
      true,
    );
    first.shell.teardown();
    first.root.remove();

    // The reload: nothing of the old shell survives except what went to storage.
    const second = mountShell();
    expect(wasMinimised()).toBe(true);
    // The decision session start actually makes, with the preference left ON — asserting the fresh
    // shell merely HAS no chat open would pass without any of this, because a bare shell never does.
    expect(
      shouldAutoOpenChat(true),
      'session start would reopen the chat over the app, which is the click that timed out',
    ).toBe(false);
    expect(second.root.querySelector(`[${CHAT_ATTR}]`)).toBeNull();
    second.shell.teardown();
    second.root.remove();
  });

  it('expanding clears it, so the next reload brings the panel back', () => {
    const { shell, root } = mountShell();
    shell.collapse();
    shell.expand();
    expect(wasMinimised()).toBe(false);
    expect(shouldAutoOpenChat(true), 'the preference is back in charge once expanded').toBe(true);
    shell.teardown();
    root.remove();
  });
});
