import { describe, it, expect, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installRoute } from './route.js';
import { captureMethod } from '../patching/capture-method.js';
import type { Emit, Teardown } from './types.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

function collect(): { emit: Emit; events: Emitted[] } {
  const events: Emitted[] = [];
  const emit: Emit = (type, data) => {
    events.push({ type, data });
  };
  return { emit, events };
}

describe('installRoute', () => {
  let teardown: Teardown | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('emits ROUTE_CHANGE on pushState to a new url', () => {
    const { emit, events } = collect();
    teardown = installRoute(emit);

    history.pushState({}, '', '/next');

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.ROUTE_CHANGE);
    expect(String(events[0]?.data['pathname'])).toBe('/next');
  });

  it('emits ROUTE_CHANGE on a Back navigation after a pushState (stale-lastHref regression)', async () => {
    const { emit, events } = collect();
    history.replaceState({}, '', '/a');
    teardown = installRoute(emit);

    history.pushState({}, '', '/b'); // /a -> /b
    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      history.back(); // back to /a
    });

    const backNav = events.find(
      (e) => String(e.data['from']).endsWith('/b') && String(e.data['to']).endsWith('/a'),
    );
    expect(backNav).toBeDefined();
  });

  it('restores the original history methods (identity) on teardown', () => {
    // Identity is the whole assertion — teardown has to put back the SAME function object, not an
    // equivalent one — so the references are captured the same way the observer captures them.
    const beforePush = captureMethod(history, 'pushState');
    const beforeReplace = captureMethod(history, 'replaceState');
    const t = installRoute(collect().emit);
    expect(captureMethod(history, 'pushState')).not.toBe(beforePush);
    t();
    expect(captureMethod(history, 'pushState')).toBe(beforePush);
    expect(captureMethod(history, 'replaceState')).toBe(beforeReplace);
  });

  it('does NOT clobber a wrapper the app layered on top after connect()', () => {
    // A router/analytics SDK that wraps history.pushState AFTER Reticle installed must keep its
    // instrumentation on teardown. Blindly restoring the original would silently uninstall it —
    // the dev-only SDK breaking the app it only meant to observe.
    const origPush = captureMethod(history, 'pushState');
    const t = installRoute(collect().emit);
    const reticleWrapper = captureMethod(history, 'pushState');
    let outerCalls = 0;
    const outer = function (this: History, ...args: unknown[]): void {
      outerCalls += 1;
      (reticleWrapper as (...a: unknown[]) => void).apply(this, args);
    };
    history.pushState = outer as typeof history.pushState;

    t(); // Reticle tears down

    // The app's wrapper survived — teardown saw it was not Reticle's and left it in place.
    expect(captureMethod(history, 'pushState')).toBe(outer);
    history.pushState({}, '', '/x');
    expect(outerCalls).toBe(1);
    history.pushState = origPush; // don't leak the wrapper into other tests
  });
});
