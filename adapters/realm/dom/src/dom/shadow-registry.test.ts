import { describe, expect, it, afterEach } from 'vitest';
import {
  installShadowRegistry,
  capturedRoots,
  capturedRootOf,
  isCaptured,
  onShadowRoot,
  MAX_TRACKED_ROOTS,
  SWEEP_EVERY,
} from './shadow-registry.js';
import { captureMethod } from '../patching/capture-method.js';

/**
 * A closed shadow root is unreadable AFTER the fact — `el.shadowRoot` is null forever — but
 * `attachShadow` RETURNS it at the moment of creation. These pin both halves of that: what the patch
 * catches becomes reachable, and what it was too late for stays honestly unreachable.
 */
describe('shadow registry', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    document.body.innerHTML = '';
  });

  it('captures a CLOSED root created after install, which nothing else can read', () => {
    uninstall = installShadowRegistry();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<span>hidden</span>';

    expect(host.shadowRoot).toBeNull(); // the whole difficulty, restated
    expect(isCaptured(host)).toBe(true);
    expect(capturedRootOf(host)).toBe(root);
    expect(capturedRoots()).toContain(root);
  });

  it('sweeps OPEN roots that already existed at install', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    uninstall = installShadowRegistry();
    expect(capturedRoots()).toContain(root);
  });

  it('does NOT claim a closed root that predates install', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'closed' });
    uninstall = installShadowRegistry();
    // Unreachable in principle from here — and reported as such rather than silently skipped.
    expect(isCaptured(host)).toBe(false);
    expect(capturedRootOf(host)).toBeNull();
  });

  it('notifies subscribers so the DOM observer can attach to a root that appears later', () => {
    uninstall = installShadowRegistry();
    const seen: ShadowRoot[] = [];
    const unsubscribe = onShadowRoot((root) => seen.push(root));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    expect(seen).toEqual([root]);

    unsubscribe();
    document.body.appendChild(document.createElement('div')).attachShadow({ mode: 'open' });
    expect(seen).toHaveLength(1);
  });

  it('restores attachShadow on teardown', () => {
    const before = captureMethod(Element.prototype, 'attachShadow');
    const stop = installShadowRegistry();
    expect(captureMethod(Element.prototype, 'attachShadow') === before).toBe(false);
    stop();
    expect(captureMethod(Element.prototype, 'attachShadow') === before).toBe(true);
  });

  it('leaves a later patch in place rather than clobbering it', () => {
    const stop = installShadowRegistry();
    const later = captureMethod(Element.prototype, 'attachShadow');
    const theirs = function theirAttachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
      return later.call(this, init);
    };
    Element.prototype.attachShadow = theirs;
    stop();
    expect(captureMethod(Element.prototype, 'attachShadow') === theirs).toBe(true);
    Element.prototype.attachShadow = later;
  });
});

describe('HMR: connect() runs again before the old instance is torn down', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * A dev-only SDK gets installed more than once — Vite re-runs the module on hot reload. The state
   * here is module-level, so a teardown that cleared it unconditionally silenced whoever else was
   * still using it. Measured: the DOM observer stopped being told about new shadow roots for the
   * rest of the session, with no error anywhere.
   */
  it('a foreign teardown does not silence an earlier instance subscribers', () => {
    const stopA = installShadowRegistry();
    const seen: ShadowRoot[] = [];
    onShadowRoot((root) => seen.push(root));
    const stopB = installShadowRegistry();
    stopB();

    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' });
    expect(seen).toHaveLength(1);
    stopA();
  });

  it('the last teardown still restores the prototype and clears the state', () => {
    const pristine = captureMethod(Element.prototype, 'attachShadow');
    const stopA = installShadowRegistry();
    const stopB = installShadowRegistry();
    stopB();
    expect(captureMethod(Element.prototype, 'attachShadow') === pristine).toBe(false);
    stopA();
    expect(captureMethod(Element.prototype, 'attachShadow') === pristine).toBe(true);
    expect(capturedRoots()).toHaveLength(0);
  });
});

/**
 * Generous per-test budget for the churn tests below.
 *
 * They build thousands of DOM nodes, and vitest's default 5 000 ms is a statement about the runner,
 * not about the code — observed timing out at 7 410 ms on a Windows CI box while the assertion it
 * was making held fine. CLAUDE.md prescribes exactly this remedy: a generous explicit timeout, never
 * a number that turns load into a red build.
 *
 * A bigger number cannot make a broken test pass — the bound is still asserted.
 */
const HEAVY_DOM_TIMEOUT_MS = 60_000;

describe('a long session with churning web components', () => {
  /**
   * The registry held roots in a strong Set that only cleared on teardown. Measured: a virtualized
   * list rendering and removing 5,000 web-component rows left all 5,000 retained — each pinning its
   * shadow subtree and, through `root.host`, the row itself. A design system's rows ARE web
   * components, so the most ordinary data-heavy page was the worst case, in an SDK meant to sit in a
   * dev session all day.
   */
  it(
    'stays bounded while a list renders and discards thousands of rows',
    () => {
      const stop = installShadowRegistry();
      for (let i = 0; i < 5000; i++) {
        const host = document.createElement('div');
        document.body.appendChild(host);
        host.attachShadow({ mode: 'open' }).innerHTML = `<span>row ${String(i)}</span>`;
        host.remove();
      }
      // The entries are weak, so a real engine collects the roots outright; the cap is the backstop
      // that bounds the bookkeeping even where nothing has been collected yet.
      //
      // The bound is MAX + SWEEP_EVERY, not MAX: the sweep is amortized so the cap is enforced once
      // per SWEEP_EVERY records rather than on each one. What matters is that it does not grow with
      // churn — 5,000 rows in, and the ceiling is the same as it would be for 50,000.
      expect(capturedRoots().length).toBeLessThanOrEqual(MAX_TRACKED_ROOTS + SWEEP_EVERY);
      stop();
    },
    HEAVY_DOM_TIMEOUT_MS,
  );

  it('still recognises a root it has already seen, without scanning every root', () => {
    const stop = installShadowRegistry();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const seen: ShadowRoot[] = [];
    const off = onShadowRoot((r) => seen.push(r));
    // A second install sweeps existing roots — this one is already known and must not be re-reported.
    const stopB = installShadowRegistry();
    expect(seen).toHaveLength(0);
    expect(capturedRoots()).toContain(root);
    off();
    stopB();
    stop();
  });
});
