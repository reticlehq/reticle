/**
 * Where the HUD's pages and their names are, pinned.
 *
 * A HUD audit for the release found three promises with nothing that would fail if they broke: the
 * plan board sits on the Harness page (its own describe still said "on the Agent Log"), every
 * bottom-bar icon is named under it (only Impact's name was tested), and the Harness page is a
 * signed-in person's (its button's visibility was untested).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOTATIONS_HTML,
  CHAT_VIEWS_HTML,
  CHAT_VIEWS_NAV_HTML,
  FLOWS_PAGE_HTML,
  HARNESS_PAGE_HTML,
  ChatViews,
} from './presenter-chat-views.js';
import { PLAN_ATTR } from './presenter-plan.js';

const mount = () => {
  document.body.innerHTML = `<div data-reticle-overlay><div data-reticle-chat-panel>${CHAT_VIEWS_HTML}<section class="reticle-chat-view" aria-label="Agent Log"></section></div>${FLOWS_PAGE_HTML}${HARNESS_PAGE_HTML}${ANNOTATIONS_HTML}${CHAT_VIEWS_NAV_HTML}</div>`;
  const root = document.querySelector<HTMLElement>('[data-reticle-overlay]');
  if (null === root) throw new Error('the HUD failed to mount');
  const views = new ChatViews(vi.fn(), vi.fn(), {
    run: vi.fn(),
    stop: vi.fn(),
    setHarness: vi.fn(),
    link: vi.fn(),
  });
  views.mount(root);
  return { root, views };
};

const harnessButton = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>('[data-reticle-chat-view-btn="harness"]');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the plan board', () => {
  it('sits on the Harness page, and nowhere in the Agent Log', () => {
    const { root } = mount();
    const boards = root.querySelectorAll(`[${PLAN_ATTR}]`);
    expect(boards).toHaveLength(1);
    expect(boards[0]?.closest('[data-reticle-page-panel="harness"]')).not.toBeNull();
    expect(root.querySelector(`[data-reticle-chat-panel] [${PLAN_ATTR}]`)).toBeNull();
  });
});

describe('the bottom bar', () => {
  it('names every page under its icon', () => {
    const { root } = mount();
    const names = [...root.querySelectorAll('.reticle-chat-nav button .reticle-nav-label')].map(
      (label) => (label.firstChild?.textContent ?? '').trim(),
    );
    expect(names).toEqual(['Log', 'Harness', 'Flows', 'Notes', 'Impact']);
  });

  it('shows the Harness page only to a signed-in person', () => {
    const { root, views } = mount();
    views.paintAccount({ signedIn: false });
    expect(harnessButton(root)?.hidden).toBe(true);
    views.paintAccount(undefined);
    expect(harnessButton(root)?.hidden).toBe(true);
    views.paintAccount({ signedIn: true });
    expect(harnessButton(root)?.hidden).toBe(false);
  });
});
