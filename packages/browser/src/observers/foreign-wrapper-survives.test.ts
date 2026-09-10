/**
 * Teardown restores what WE put there, and only that.
 *
 * A monkeypatch teardown that writes the original back unconditionally does not "clean up" — it
 * uninstalls whoever wrapped the slot after us. A router, Sentry, a polyfill or the app's own test
 * harness that patched `window.open`, `URL.createObjectURL` or `HTMLAnchorElement.prototype.click`
 * AFTER `connect()` would silently lose its instrumentation the moment the agent disconnected, and
 * nothing in the app would say why.
 *
 * `route.ts` already had the rule written down. These sites now follow it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { installContextOpen } from './context-open.js';
import { installDownload } from './download.js';
import { captureMethod } from '../patching/capture-method.js';
import type { Emit, Teardown } from './types.js';

const quiet: Emit = () => undefined;

const teardowns: Teardown[] = [];
afterEach(() => {
  for (const t of teardowns.splice(0)) t();
});

type SlotMap = Record<string, (...args: unknown[]) => unknown>;

describe('a wrapper installed after connect() survives teardown', () => {
  it('leaves window.open to whoever wrapped it last', () => {
    const slots = window as unknown as SlotMap;
    const before = captureMethod(slots, 'open');
    try {
      const teardown = installContextOpen(quiet);
      const ours = captureMethod(slots, 'open');
      const theirs = (...args: unknown[]): unknown => ours(...args);
      slots['open'] = theirs;

      teardown();

      expect(captureMethod(slots, 'open')).toBe(theirs);
    } finally {
      slots['open'] = before;
    }
  });

  it('leaves URL.createObjectURL and anchor click to whoever wrapped them last', () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:test/foreign',
    });
    const urlSlots = URL as unknown as SlotMap;
    const anchorSlots = HTMLAnchorElement.prototype as unknown as SlotMap;
    const urlBefore = captureMethod(urlSlots, 'createObjectURL');
    const clickBefore = captureMethod(anchorSlots, 'click');
    try {
      const teardown = installDownload(quiet, {});
      const ourCreate = captureMethod(urlSlots, 'createObjectURL');
      const ourClick = captureMethod(anchorSlots, 'click');
      const theirCreate = (...args: unknown[]): unknown => ourCreate(...args);
      const theirClick = (...args: unknown[]): unknown => ourClick(...args);
      urlSlots['createObjectURL'] = theirCreate;
      anchorSlots['click'] = theirClick;

      teardown();

      expect(captureMethod(urlSlots, 'createObjectURL')).toBe(theirCreate);
      expect(captureMethod(anchorSlots, 'click')).toBe(theirClick);
    } finally {
      urlSlots['createObjectURL'] = urlBefore;
      anchorSlots['click'] = clickBefore;
    }
  });
});
