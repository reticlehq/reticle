import { EventType, type ReticleEvent } from '@reticlehq/core';

interface RouteLearningSession {
  url: string;
  /**
   * The `.reticle` this session's artifacts belong in, stamped on session-create. Undefined only
   * for a caller that does not stamp one, which resolves to the daemon's own root.
   */
  artifactRoot?: string | undefined;
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

/**
 * Persist initial and subsequent routes for existing and future browser sessions.
 *
 * `storeFor` resolves the store for ONE session's artifact root, rather than the daemon being handed
 * a single store bound to its own `process.cwd()`. That binding was right only when the daemon
 * happened to be started inside the app it was driving — and a user-scoped MCP registration, the
 * common case, starts it wherever the editor's cwd is. The routes of every app then landed in that
 * directory, which is how a `.reticle/` kept reappearing in a backend nobody had instrumented,
 * while the driven project's own memory never filled.
 */
export function attachRouteLearning(
  bridge: RouteLearningBridge,
  storeFor: (root: string | undefined) => RouteLearningStore,
): void {
  const attached = new WeakSet<RouteLearningSession>();
  // Keyed by STORE rather than by root path: `storeFor` already answers one store per root, so this
  // cannot disagree with it about which roots are distinct.
  const pending = new Map<RouteLearningStore, Set<string>>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    flushTimer = undefined;
    const batches = [...pending];
    pending.clear();
    for (const [store, routes] of batches) {
      if (routes.size > 0) void store.recordRoutes([...routes]).catch(() => undefined);
    }
  };

  const queue = (store: RouteLearningStore, route: string): void => {
    const routes = pending.get(store) ?? new Set<string>();
    routes.add(route);
    pending.set(store, routes);
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, ROUTE_PERSIST_DEBOUNCE_MS);
  };

  const attach = (session: RouteLearningSession): void => {
    if (attached.has(session)) return;
    attached.add(session);
    const store = storeFor(session.artifactRoot);

    const initial = routeFromUrl(session.url);
    if (initial !== undefined) queue(store, initial);
    session.onEvent((event) => {
      const route = routeFromEvent(event);
      if (route !== undefined) queue(store, route);
    });
  };

  for (const session of bridge.sessions.all()) attach(session);
  bridge.attachSessionReady(attach);
}
