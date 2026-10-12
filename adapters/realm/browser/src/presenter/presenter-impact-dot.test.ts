import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_VIEWS_NAV_HTML, ChatViews, CHAT_VIEWS_CSS } from './presenter-chat-views.js';
import { HudShell } from './presenter-shell.js';
import { IMPACT_SEEN_KEY_PREFIX, isReticleStorageKey } from '@/storage-keys.js';

/*
 * The Impact tab's "new since you last looked" dot. It replaced an inline count beside the label,
 * which grew with the number until a four-digit total pushed "Impact" into its neighbour's name.
 */
const mount = (projectId = 'shop') => {
  document.body.innerHTML = `<div data-reticle-overlay>${CHAT_VIEWS_NAV_HTML}</div>`;
  const root = document.querySelector<HTMLElement>('[data-reticle-overlay]');
  if (null === root) throw new Error('nav failed to mount');
  const views = new ChatViews(vi.fn(), vi.fn());
  views.setProjectId(projectId);
  views.mount(root);
  return { root, views };
};
const button = (root: ParentNode): HTMLElement => {
  const el = root.querySelector<HTMLElement>('[data-reticle-chat-impact]');
  if (null === el) throw new Error('no Impact control');
  return el;
};
const dotShown = (root: ParentNode): boolean =>
  false === (root.querySelector<HTMLElement>('[data-reticle-impact-dot]')?.hidden ?? true);

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the Impact dot', () => {
  it('shows when the results grew since Impact was last opened, and says so to a screen reader', () => {
    const { root, views } = mount();
    views.paintImpact(74);
    expect(dotShown(root)).toBe(true);
    expect(button(root).getAttribute('aria-label')).toBe('Open Impact, new results');
  });

  it('clears the moment Impact opens, and stays cleared after a reload', () => {
    const first = mount();
    first.views.paintImpact(74);
    first.views.setImpactOpen(true);
    expect(dotShown(first.root)).toBe(false);
    expect(button(first.root).getAttribute('aria-label')).toBe('Open Impact');
    const reloaded = mount();
    reloaded.views.paintImpact(74);
    expect(dotShown(reloaded.root)).toBe(false);
  });

  it('comes back when new results arrive after that', () => {
    const { root, views } = mount();
    views.paintImpact(74);
    views.setImpactOpen(true);
    views.setImpactOpen(false);
    views.paintImpact(75);
    expect(dotShown(root)).toBe(true);
  });

  it('never shows for results that land while Impact is already open', () => {
    const { root, views } = mount();
    views.setImpactOpen(true);
    views.paintImpact(80);
    views.setImpactOpen(false);
    expect(dotShown(root)).toBe(false);
  });

  it('remembers each project separately', () => {
    const shop = mount('shop');
    shop.views.paintImpact(10);
    shop.views.setImpactOpen(true);
    const other = mount('other');
    other.views.paintImpact(10);
    expect(dotShown(other.root)).toBe(true);
  });

  it('shows nothing, and does not throw, when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { root, views } = mount();
    expect(() => views.paintImpact(74)).not.toThrow();
    expect(dotShown(root)).toBe(false);
    expect(() => views.setImpactOpen(true)).not.toThrow();
    views.setImpactOpen(false);
    views.paintImpact(99);
    expect(dotShown(root)).toBe(false);
  });

  it('keeps the label exactly "Impact", with or without the dot, at five digits', () => {
    const { root, views } = mount();
    const label = (): string =>
      button(root).querySelector('.reticle-nav-label')?.outerHTML ?? 'missing';
    views.setImpactOpen(true);
    const quiet = label();
    views.setImpactOpen(false);
    views.paintImpact(12345);
    expect(dotShown(root)).toBe(true);
    expect(label()).toBe(quiet);
    expect(button(root).querySelector('.reticle-nav-label')?.textContent).toBe('Impact');
    expect(root.textContent).not.toContain('12345');
    // Out of the flow: a dot cannot push the label, whatever the number behind it.
    expect(CHAT_VIEWS_CSS).toMatch(/\.reticle-nav-dot\{[^}]*position:absolute/);
  });

  it('writes a key the storage observer knows is Reticle’s own', () => {
    expect(isReticleStorageKey(`${IMPACT_SEEN_KEY_PREFIX}shop`)).toBe(true);
  });

  it('is cleared by opening Impact from the toolbar', async () => {
    document.body.innerHTML = `<div id="root">${HudShell.dockHtml('', '', 'data-reticle-log', '', '')}</div>`;
    const root = document.querySelector<HTMLElement>('#root');
    if (null === root) throw new Error('no root');
    const shell = new HudShell({});
    shell.setProjectId('shop');
    shell.mount(root);
    shell.paintImpact(5);
    expect(dotShown(document)).toBe(true);
    button(document).click();
    await Promise.resolve();
    expect(dotShown(document)).toBe(false);
    shell.teardown();
  });
});
