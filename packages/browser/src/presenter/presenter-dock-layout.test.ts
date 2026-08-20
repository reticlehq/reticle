import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_ATTR,
  CHAT_PANEL_ATTR,
  CHAT_PLACEMENT_ATTR,
  DOCK_ALIGN_ATTR,
  DOCK_ATTR,
  Placement,
  SETTINGS_ATTR,
  SETTINGS_PANEL_ATTR,
  SETTINGS_PLACEMENT_ATTR,
} from './presenter-config.js';
import { applyHudPosition } from './presenter-drag.js';
import { syncDockLayout } from './presenter-dock-layout.js';

function mountDockFixture(): { overlay: HTMLElement; dock: HTMLElement; hud: HTMLElement } {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-reticle-overlay', '');
  const dock = document.createElement('div');
  dock.setAttribute(DOCK_ATTR, '');
  const chat = document.createElement('div');
  chat.setAttribute(CHAT_PANEL_ATTR, '');
  chat.style.display = 'flex';
  chat.style.height = '320px';
  chat.style.width = '320px';
  const settings = document.createElement('div');
  settings.setAttribute(SETTINGS_PANEL_ATTR, '');
  settings.style.display = 'none';
  const hud = document.createElement('div');
  hud.setAttribute('data-reticle-hud', '');
  hud.style.width = '320px';
  hud.style.height = '44px';
  dock.append(chat, settings, hud);
  overlay.append(dock);
  document.body.append(overlay);
  return { overlay, dock, hud };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('presenter dock layout', () => {
  it('opens chat below the HUD when there is no room above', () => {
    const { overlay, dock, hud } = mountDockFixture();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    applyHudPosition(dock, 20, 12);
    hud.getBoundingClientRect = (): DOMRect => ({
      left: 20,
      top: 12,
      right: 340,
      bottom: 56,
      width: 320,
      height: 44,
      x: 20,
      y: 12,
      toJSON: () => ({}),
    });
    const chat = dock.querySelector(`[${CHAT_PANEL_ATTR}]`) as HTMLElement;
    chat.getBoundingClientRect = (): DOMRect => ({
      left: 20,
      top: -316,
      right: 340,
      bottom: 4,
      width: 320,
      height: 320,
      x: 20,
      y: -316,
      toJSON: () => ({}),
    });
    overlay.setAttribute(CHAT_ATTR, '1');

    syncDockLayout(dock, overlay);

    expect(dock.getAttribute(CHAT_PLACEMENT_ATTR)).toBe(Placement.BELOW);
  });

  it('keeps chat above the HUD when there is room above', () => {
    const { overlay, dock, hud } = mountDockFixture();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    applyHudPosition(dock, 860, 700);
    hud.getBoundingClientRect = (): DOMRect => ({
      left: 860,
      top: 700,
      right: 1180,
      bottom: 744,
      width: 320,
      height: 44,
      x: 860,
      y: 700,
      toJSON: () => ({}),
    });
    const chat = dock.querySelector(`[${CHAT_PANEL_ATTR}]`) as HTMLElement;
    chat.getBoundingClientRect = (): DOMRect => ({
      left: 860,
      top: 372,
      right: 1180,
      bottom: 692,
      width: 320,
      height: 320,
      x: 860,
      y: 372,
      toJSON: () => ({}),
    });
    overlay.setAttribute(CHAT_ATTR, '1');

    syncDockLayout(dock, overlay);

    expect(dock.getAttribute(CHAT_PLACEMENT_ATTR)).toBe(Placement.ABOVE);
  });

  it('reclamps a dragged dock when panels overflow the viewport horizontally', () => {
    const { overlay, dock, hud } = mountDockFixture();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    applyHudPosition(dock, 1100, 700);
    hud.getBoundingClientRect = (): DOMRect => ({
      left: 1100,
      top: 700,
      right: 1420,
      bottom: 744,
      width: 320,
      height: 44,
      x: 1100,
      y: 700,
      toJSON: () => ({}),
    });
    const chat = dock.querySelector(`[${CHAT_PANEL_ATTR}]`) as HTMLElement;
    chat.getBoundingClientRect = (): DOMRect => ({
      left: 1100,
      top: 372,
      right: 1420,
      bottom: 692,
      width: 320,
      height: 320,
      x: 1100,
      y: 372,
      toJSON: () => ({}),
    });
    overlay.setAttribute(CHAT_ATTR, '1');

    syncDockLayout(dock, overlay);

    expect(Number.parseFloat(dock.style.getPropertyValue('--reticle-hud-x'))).toBeLessThan(1100);
  });

  it('aligns panels to the left when the dock is near the viewport edge', () => {
    const { overlay, dock, hud } = mountDockFixture();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    applyHudPosition(dock, 20, 700);
    hud.getBoundingClientRect = (): DOMRect => ({
      left: 20,
      top: 700,
      right: 200,
      bottom: 744,
      width: 180,
      height: 44,
      x: 20,
      y: 700,
      toJSON: () => ({}),
    });
    const chat = dock.querySelector(`[${CHAT_PANEL_ATTR}]`) as HTMLElement;
    chat.getBoundingClientRect = (): DOMRect => ({
      left: 20,
      top: 372,
      right: 340,
      bottom: 692,
      width: 320,
      height: 320,
      x: 20,
      y: 372,
      toJSON: () => ({}),
    });
    overlay.setAttribute(CHAT_ATTR, '1');

    syncDockLayout(dock, overlay);

    expect(dock.getAttribute(DOCK_ALIGN_ATTR)).toBe('start');
  });

  it('flips settings below when the dock is pinned to the top', () => {
    const { overlay, dock, hud } = mountDockFixture();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    applyHudPosition(dock, 20, 12);
    hud.getBoundingClientRect = (): DOMRect => ({
      left: 20,
      top: 12,
      right: 340,
      bottom: 56,
      width: 320,
      height: 44,
      x: 20,
      y: 12,
      toJSON: () => ({}),
    });
    const settings = dock.querySelector(`[${SETTINGS_PANEL_ATTR}]`) as HTMLElement;
    settings.style.display = 'block';
    settings.style.height = '360px';
    settings.getBoundingClientRect = (): DOMRect => ({
      left: 20,
      top: -352,
      right: 292,
      bottom: 8,
      width: 272,
      height: 360,
      x: 20,
      y: -352,
      toJSON: () => ({}),
    });
    overlay.setAttribute(SETTINGS_ATTR, '1');

    syncDockLayout(dock, overlay);

    expect(dock.getAttribute(SETTINGS_PLACEMENT_ATTR)).toBe(Placement.BELOW);
  });
});
