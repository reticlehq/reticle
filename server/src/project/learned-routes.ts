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

/** Coalesce navigation bursts so one crawl does not lock and rewrite project.json per event. */
export const ROUTE_PERSIST_DEBOUNCE_MS = 50;

/** Convert a validated route-change payload into a bounded route identity. */
export function routeFromEvent(event: ReticleEvent): string | undefined {
  if (event.type !== EventType.ROUTE_CHANGE) return undefined;
  const pathname = event.data['pathname'];
  if ('string' !== typeof pathname || 0 === pathname.length) return undefined;
  return pathname;
}

/** Read the same route shape from a session's absolute URL. */
export function routeFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.pathname;
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
  const pending = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    flushTimer = undefined;
    const routes = [...pending];
    pending.clear();
    if (routes.length > 0) void project.recordRoutes(routes).catch(() => undefined);
  };

  const queue = (route: string): void => {
    pending.add(route);
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, ROUTE_PERSIST_DEBOUNCE_MS);
  };

  const attach = (session: RouteLearningSession): void => {
    if (attached.has(session)) return;
    attached.add(session);

    const initial = routeFromUrl(session.url);
    if (initial !== undefined) queue(initial);
    session.onEvent((event) => {
      const route = routeFromEvent(event);
      if (route !== undefined) queue(route);
    });
  };

  for (const session of bridge.sessions.all()) attach(session);
  bridge.attachSessionReady(attach);
}
