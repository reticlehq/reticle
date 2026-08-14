import { describe, expect, it, vi } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { attachRouteLearning, routeFromEvent, routeFromUrl } from './learned-routes.js';

function routeEvent(pathname: string, search = '', hash = ''): ReticleEvent {
  return {
    t: 1,
    type: EventType.ROUTE_CHANGE,
    sessionId: 's1',
    data: { from: '', to: '', pathname, search, hash },
  };
}

describe('learned routes', () => {
  it('normalizes route events and session URLs without persisting origins', () => {
    expect(routeFromEvent(routeEvent('/search', '?q=reticle', '#results'))).toBe(
      '/search?q=reticle#results',
    );
    expect(routeFromUrl('https://example.test/deployments?region=us#latest')).toBe(
      '/deployments?region=us#latest',
    );
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

  it('records the initial route and every ordinary route change', async () => {
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
    await vi.waitFor(() => expect(recordRoutes).toHaveBeenCalledTimes(2));

    expect(recordRoutes.mock.calls).toEqual([[['/']], [['/compose']]]);
  });
});

interface TestSession {
  url: string;
  onEvent(handler: (event: ReticleEvent) => void): () => void;
}
