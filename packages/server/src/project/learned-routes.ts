import { EventType, type ReticleEvent } from '@reticlehq/core';

interface RouteLearningSession {
  url: string;
  onEvent(handler: (event: ReticleEvent) => void): () => void;
}

interface RouteLearningBridge {
  sessions: { all(): RouteLearningSession[] };
  attachSessionReady(handler: (session: RouteLearningSession) => void): void;
}

interface RouteLearningStore {
  recordRoutes(routes: readonly string[]): Promise<void>;
}

/** Convert a validated route-change payload into the route users see, without persisting its origin. */
export function routeFromEvent(event: ReticleEvent): string | undefined {
  if (event.type !== EventType.ROUTE_CHANGE) return undefined;
  const pathname = event.data['pathname'];
  if ('string' !== typeof pathname || 0 === pathname.length) return undefined;
  const search = 'string' === typeof event.data['search'] ? event.data['search'] : '';
  const hash = 'string' === typeof event.data['hash'] ? event.data['hash'] : '';
  return `${pathname}${search}${hash}`;
}

/** Read the same route shape from a session's absolute URL. */
export function routeFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export function routesFromEvents(events: readonly ReticleEvent[]): string[] {
  return events.flatMap((event) => {
    const route = routeFromEvent(event);
    return route === undefined ? [] : [route];
  });
}

/** Persist initial and subsequent routes for existing and future browser sessions. */
export function attachRouteLearning(
  bridge: RouteLearningBridge,
  project: RouteLearningStore,
): void {
  const attached = new WeakSet<RouteLearningSession>();
  const attach = (session: RouteLearningSession): void => {
    if (attached.has(session)) return;
    attached.add(session);

    const initial = routeFromUrl(session.url);
    if (initial !== undefined) void project.recordRoutes([initial]).catch(() => undefined);
    session.onEvent((event) => {
      const route = routeFromEvent(event);
      if (route !== undefined) void project.recordRoutes([route]).catch(() => undefined);
    });
  };

  for (const session of bridge.sessions.all()) attach(session);
  bridge.attachSessionReady(attach);
}
