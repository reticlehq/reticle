import { describe, it, expect, afterEach } from 'vitest';
import { RETICLE_ROOT_GLOBAL } from '@reticlehq/core';
import {
  mountWorkspaceSelector,
  paintWorkspace,
  workspaceFolderLabel,
  workspaceRowHtml,
} from './presenter-workspace.js';

afterEach(() => {
  Reflect.deleteProperty(globalThis, RETICLE_ROOT_GLOBAL);
  document.body.innerHTML = '';
});

describe('presenter workspace selector', () => {
  it('renders a workspace chip above the composer', () => {
    expect(workspaceRowHtml()).toContain('data-reticle-workspace-btn');
    expect(workspaceRowHtml()).toContain('reticle-workspace-name');
  });

  it('labels the folder from the injected repo root', () => {
    (globalThis as Record<string, unknown>)[RETICLE_ROOT_GLOBAL] = 'C:/apps/linkit_v5';
    expect(workspaceFolderLabel('C:/apps/linkit_v5')).toBe('linkit_v5');
    document.body.innerHTML = `<div data-reticle-overlay>${workspaceRowHtml()}</div>`;
    paintWorkspace(document.body);
    expect(document.querySelector('[data-reticle-workspace-name]')?.textContent).toBe('linkit_v5');
  });

  it('opens and closes the workspace detail menu', () => {
    document.body.innerHTML = `<div data-reticle-overlay>${workspaceRowHtml()}</div>`;
    const teardown = mountWorkspaceSelector(document.body);
    const btn = document.querySelector('[data-reticle-workspace-btn]') as HTMLElement;
    btn.click();
    expect(
      document.querySelector('[data-reticle-workspace-menu]')?.getAttribute('aria-hidden'),
    ).toBe('false');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(
      document.querySelector('[data-reticle-workspace-menu]')?.getAttribute('aria-hidden'),
    ).toBe('true');
    teardown();
  });
});

/**
 * A chip that cannot name the workspace should not take the slot.
 *
 * With no injected repo root and no leased project id it rendered "This page" - a label that names
 * no checkout and is equally true of every page in every app.
 */
describe('the workspace chip hides when it knows nothing', () => {
  it('is hidden with no root and no project id, and shown once a root exists', () => {
    document.body.innerHTML = `<div class="reticle-workspace-wrap"><button data-reticle-workspace-btn><span data-reticle-workspace-name></span></button></div>`;
    const root = document.body;
    paintWorkspace(root);
    const wrap = document.querySelector('.reticle-workspace-wrap');
    expect(wrap?.hasAttribute('hidden'), 'nothing to say, nothing shown').toBe(true);
    (globalThis as Record<string, unknown>)[RETICLE_ROOT_GLOBAL] = '/Users/me/code/checkout';
    try {
      paintWorkspace(root);
      expect(wrap?.hasAttribute('hidden'), 'a known checkout is worth a chip').toBe(false);
      expect(document.querySelector('[data-reticle-workspace-name]')?.textContent).toBe('checkout');
    } finally {
      delete (globalThis as Record<string, unknown>)[RETICLE_ROOT_GLOBAL];
    }
  });
});
