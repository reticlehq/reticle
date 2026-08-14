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

    attachRouteLearning(bridge, { recordRoutes });
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

interface TestSession {
  url: string;
  onEvent(handler: (event: ReticleEvent) => void): () => void;
}
