import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import {
  attachRouteLearning,
  ROUTE_PERSIST_DEBOUNCE_MS,
  routeFromEvent,
  routeFromUrl,
} from './learned-routes.js';

function routeEvent(pathname: string, search = '', hash = ''): ReticleEvent {
  return {
    t: 1,
    type: EventType.ROUTE_CHANGE,
    sessionId: 's1',
    data: { from: '', to: '', pathname, search, hash },
  };
}

describe('learned routes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses pathname route identities without persisting origins, searches, or hashes', () => {
    expect(routeFromEvent(routeEvent('/search', '?q=reticle', '#results'))).toBe('/search');
    expect(routeFromUrl('https://example.test/deployments?region=us#latest')).toBe('/deployments');
  });

  it('ignores non-route events and invalid URLs', () => {
    expect(
      routeFromEvent({
        t: 1,
        type: EventType.DOM_ADDED,
        sessionId: 's1',
        data: {},
      }),
    ).toBeUndefined();
    expect(routeFromUrl('not a URL')).toBeUndefined();
  });

  it('batches the initial route and rapid ordinary route changes into one store update', async () => {
    vi.useFakeTimers();
    let ready: ((session: TestSession) => void) | undefined;
    let listener: ((event: ReticleEvent) => void) | undefined;
    const recordRoutes = vi.fn<(routes: readonly string[]) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const session: TestSession = {
      url: 'https://example.test/',
      onEvent: (handler) => {
        listener = handler;
        return () => undefined;
      },
    };
    const bridge = {
      sessions: { all: () => [] as TestSession[] },
      attachSessionReady: (handler: (connected: TestSession) => void) => {
        ready = handler;
      },
    };

    attachRouteLearning(bridge, () => ({ recordRoutes }));
    ready?.(session);
    listener?.(routeEvent('/compose'));
    listener?.(routeEvent('/deployments'));
    listener?.(routeEvent('/compose', '?draft=2'));

    expect(recordRoutes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ROUTE_PERSIST_DEBOUNCE_MS);

    expect(recordRoutes).toHaveBeenCalledTimes(1);
    expect(recordRoutes).toHaveBeenCalledWith(['/', '/compose', '/deployments']);
  });
});

/**
 * Learned routes belong to the app that was driven, not to wherever the daemon was launched.
 *
 * The store was bound to the daemon's own root at construction, so every session's routes were
 * written there — which put a `.reticle/project.json` into a directory the user had never
 * instrumented (reported from the field as `.reticle` reappearing in a backend), and left the
 * project's own memory empty while a stranger's filled up.
 */
describe('learned routes are recorded against the session that learned them', () => {
  it('writes each session’s routes to its own artifact root', async () => {
    vi.useFakeTimers();
    const calls: { root: string; routes: readonly string[] }[] = [];
    const storeFor = (root: string | undefined) => ({
      recordRoutes: (routes: readonly string[]): Promise<void> => {
        calls.push({ root: root ?? 'daemon', routes });
        return Promise.resolve();
      },
    });
    const sessions: TestSession[] = [
      {
        url: 'https://a.test/checkout',
        artifactRoot: '/repo/web/.reticle',
        onEvent: () => () => undefined,
      },
      {
        url: 'https://b.test/admin',
        artifactRoot: '/repo/admin/.reticle',
        onEvent: () => () => undefined,
      },
    ];
    attachRouteLearning(
      { sessions: { all: () => sessions }, attachSessionReady: () => undefined },
      storeFor,
    );
    await vi.advanceTimersByTimeAsync(ROUTE_PERSIST_DEBOUNCE_MS);

    expect(calls).toEqual([
      { root: '/repo/web/.reticle', routes: ['/checkout'] },
      { root: '/repo/admin/.reticle', routes: ['/admin'] },
    ]);
  });
});

interface TestSession {
  url: string;
  artifactRoot?: string | undefined;
  onEvent(handler: (event: ReticleEvent) => void): () => void;
}
