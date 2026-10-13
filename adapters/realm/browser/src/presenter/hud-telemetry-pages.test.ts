/**
 * Every HUD page is reported as itself, and every sign-in prompt the HUD shows is reported once.
 *
 * The Harness page opens over the Agent Log, so it was reported (and timed) as `chat`, and an open
 * account menu was not seen at all. Nothing said which sign-in asks a person had actually seen,
 * which is the top of the signup funnel.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HudPanel, HudPromptSurface, HudView, type HudUseData } from '@reticlehq/core';
import { installHudTelemetry } from './hud-telemetry.js';
import { flush } from './presenter.test-helpers.js';

function hud(inner: string): { root: HTMLElement; seen: HudUseData[]; stop: () => void } {
  const root = document.createElement('div');
  root.setAttribute('data-reticle-hud', '');
  root.setAttribute('data-reticle-min', '0');
  root.setAttribute('data-reticle-chat', '1');
  root.innerHTML = inner;
  document.body.appendChild(root);
  const seen: HudUseData[] = [];
  const stop = installHudTelemetry(document, root, (u) => seen.push(u));
  return { root, seen, stop };
}

const HARNESS_PAGE = `<section data-reticle-page-panel="harness" hidden>
  <button type="button" data-reticle-account-signin>Sign in</button></section>`;
const ACCOUNT_MENU = `<div data-reticle-account-menu hidden></div>`;
const RAIL = `<div data-reticle-rail-signin hidden><button type="button" data-reticle-account-signin>Sign in</button></div>`;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('HUD pages', () => {
  it('reports the Harness page as harness, not as the Agent Log it opens over', async () => {
    const { root, seen, stop } = hud(HARNESS_PAGE);
    root.setAttribute('data-reticle-page-open', 'harness');
    await flush();
    expect(seen.at(-1)).toEqual({ view: HudView.EXPANDED, panel: HudPanel.HARNESS });
    stop();
  });

  it('reports the account menu while it is open, and the page again once it shuts', async () => {
    const { root, seen, stop } = hud(ACCOUNT_MENU);
    const menu = root.querySelector<HTMLElement>('[data-reticle-account-menu]');
    if (null === menu) throw new Error('no menu');
    menu.hidden = false;
    await flush();
    expect(seen.at(-1)).toEqual({ view: HudView.EXPANDED, panel: HudPanel.ACCOUNT });
    menu.hidden = true;
    await flush();
    expect(seen.at(-1)).toEqual({ view: HudView.EXPANDED, panel: HudPanel.CHAT });
    stop();
  });
});

describe('sign-in prompts', () => {
  it('reports the rail card once, when it becomes visible on an open HUD', async () => {
    const { root, seen, stop } = hud(RAIL);
    await flush();
    expect(seen.filter((u) => u.prompt !== undefined)).toEqual([]);
    const rail = root.querySelector<HTMLElement>('[data-reticle-rail-signin]');
    if (null === rail) throw new Error('no rail');
    rail.hidden = false;
    await flush();
    rail.hidden = true;
    await flush();
    rail.hidden = false;
    await flush();
    expect(seen.filter((u) => u.prompt !== undefined)).toEqual([{ prompt: HudPromptSurface.RAIL }]);
    stop();
  });

  it("reports the Harness page's sign-in only while that page is the one showing", async () => {
    const { root, seen, stop } = hud(HARNESS_PAGE);
    await flush();
    expect(seen.filter((u) => u.prompt !== undefined)).toEqual([]);
    root.setAttribute('data-reticle-page-open', 'harness');
    const page = root.querySelector<HTMLElement>('[data-reticle-page-panel="harness"]');
    if (page !== null) page.hidden = false;
    await flush();
    expect(seen.filter((u) => u.prompt !== undefined)).toEqual([
      { prompt: HudPromptSurface.HARNESS },
    ]);
    stop();
  });

  it('reports the header "Save runs for your team" when it is painted in', async () => {
    const { root, seen, stop } = hud('<div data-reticle-team></div>');
    await flush();
    const slot = root.querySelector('[data-reticle-team]');
    if (slot !== null)
      slot.innerHTML =
        '<button type="button" data-reticle-team-save>Save runs for your team</button>';
    await flush();
    expect(seen.filter((u) => u.prompt !== undefined)).toEqual([
      { prompt: HudPromptSurface.HEADER },
    ]);
    stop();
  });

  it('reports nothing while the HUD is a bubble', async () => {
    const { root, seen, stop } = hud(RAIL);
    root.setAttribute('data-reticle-min', '1');
    const rail = root.querySelector<HTMLElement>('[data-reticle-rail-signin]');
    if (rail !== null) rail.hidden = false;
    await flush();
    expect(seen.filter((u) => u.prompt !== undefined)).toEqual([]);
    stop();
  });
});
