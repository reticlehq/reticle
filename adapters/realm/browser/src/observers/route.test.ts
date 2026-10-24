import { describe, it, expect, afterEach } from 'vitest';
import { EventType, ROUTE_CHANGE_HOW_FIELD, RouteChangeHow } from '@reticlehq/core';
import { declareRoutes, installRoute, patternOf } from './route.js';
import { captureMethod } from '@/patching/capture-method.js';
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
    expect(events[0]?.data[ROUTE_CHANGE_HOW_FIELD]).toBe(RouteChangeHow.PUSH);
  });

  it('removes a token in the fragment or query from every URL field it sends', () => {
    const { emit, events } = collect();
    teardown = installRoute(emit);
    history.pushState(
      null,
      '',
      '/cb?code=1&access_token=qtok#access_token=ftok&refresh_token=rtok',
    );
    history.pushState(null, '', '/next#section');
    const sent = JSON.stringify(events.map((e) => e.data));
    for (const secret of ['qtok', 'ftok', 'rtok']) expect(sent).not.toContain(secret);
    // A plain anchor is not a secret and stays readable.
    expect(events.at(-1)?.data['hash']).toBe('#section');
  });

  it('records replaceState as replace', () => {
    history.replaceState({}, '', '/editor');
    const { emit, events } = collect();
    teardown = installRoute(emit);

    history.replaceState({}, '', '/editor?zoom=125');

    expect(events).toHaveLength(1);
    expect(events[0]?.data[ROUTE_CHANGE_HOW_FIELD]).toBe(RouteChangeHow.REPLACE);
    expect(String(events[0]?.data['search'])).toBe('?zoom=125');
    expect(String(events[0]?.data['pathname'])).toBe('/editor');
  });

  it('records popstate as pop', async () => {
    history.replaceState({}, '', '/a');
    const { emit, events } = collect();
    teardown = installRoute(emit);

    history.pushState({}, '', '/b');
    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      history.back();
    });

    const backNav = events.find(
      (e) => String(e.data['from']).endsWith('/b') && String(e.data['to']).endsWith('/a'),
    );
    expect(backNav?.data[ROUTE_CHANGE_HOW_FIELD]).toBe(RouteChangeHow.POP);
  });

  it('records hashchange as pop', async () => {
    history.replaceState({}, '', '/editor');
    const { emit, events } = collect();
    teardown = installRoute(emit);

    // jsdom delivers hashchange on a later turn, and it also fires popstate for the same move.
    // The first of those is the change; the second sees an href that already matches and drops.
    await new Promise<void>((resolve) => {
      window.addEventListener('hashchange', () => resolve(), { once: true });
      location.hash = 'section';
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.data[ROUTE_CHANGE_HOW_FIELD]).toBe(RouteChangeHow.POP);
    expect(String(events[0]?.data['hash'])).toBe('#section');
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

// A screen is identified by the app's own route pattern, not by its address: a map built on addresses
// makes every record its own screen. The app declares its patterns once (any router), or the SDK
// reads them where the framework exposes them (Next.js); each route change then carries its pattern.
describe('the route pattern a change carries', () => {
  let teardown: Teardown | undefined;
  afterEach(() => {
    teardown?.();
    teardown = undefined;
    declareRoutes([]);
  });

  it('is the most specific declared pattern the path matches', () => {
    declareRoutes(['/', '/personas', '/personas/:personaId', '/settings/:group', '/settings/keys']);
    expect(patternOf('/personas/pe_4f79')).toBe('/personas/:personaId');
    expect(patternOf('/settings/keys')).toBe('/settings/keys');
    expect(patternOf('/settings/billing')).toBe('/settings/:group');
    expect(patternOf('/nowhere/at/all')).toBeUndefined();
  });

  it('rides on the route change', () => {
    declareRoutes(['/chat/:conversationId']);
    const { emit, events } = collect();
    teardown = installRoute(emit);
    history.pushState({}, '', '/chat/chat_659b61951bdf4e7d86670a75750421a4');
    expect(events[0]?.data['pattern']).toBe('/chat/:conversationId');
  });

  it('is read from Next.js when nothing was declared', () => {
    (globalThis as { next?: unknown }).next = { router: { pathname: '/runs/[runId]' } };
    expect(patternOf('/runs/run_9')).toBe('/runs/:runId');
    delete (globalThis as { next?: unknown }).next;
  });
});
