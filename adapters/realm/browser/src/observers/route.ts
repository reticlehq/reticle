import { EventType, ROUTE_CHANGE_HOW_FIELD, RouteChangeHow } from '@reticlehq/core';
import { observeSafely, type Emit, type Teardown } from './types.js';
import { captureMethod } from '@/patching/capture-method.js';
import { redactUrl } from '@reticlehq/core';

function snapshotLocation(): { pathname: string; search: string; hash: string; href: string } {
  return {
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    href: location.href,
  };
}

/**
 * The app's route patterns, declared once (`reticle.routes([...])`), so a change can say WHICH screen
 * it reached rather than only which address: `/personas/pe_4f79…` is `/personas/:personaId`. A map
 * keyed on addresses makes every record its own screen; one keyed on the app's own patterns does not.
 */
let declared: readonly { pattern: string; parts: readonly string[] }[] = [];

/** Declare the app's route patterns (`:param` for a segment, `*` for the rest). Replaces any before. */
export function declareRoutes(patterns: readonly string[]): void {
  declared = patterns.map((pattern) => ({ pattern, parts: pattern.split('/').filter(Boolean) }));
}

/** Next.js's own pattern for the page showing (`/runs/[runId]` read as `/runs/:runId`), when present. */
function nextPattern(): string | undefined {
  const raw = (globalThis as { next?: { router?: { pathname?: unknown } } }).next?.router?.pathname;
  if ('string' !== typeof raw || !raw.startsWith('/')) return undefined;
  return raw.replace(/\[\.\.\.[^\]]+\]/g, '*').replace(/\[([^\]]+)\]/g, ':$1');
}

/**
 * The pattern a path is an instance of: the most specific declared one it matches (fewest params),
 * else Next.js's own, else none (the reader falls back to its own guess).
 */
export function patternOf(pathname: string): string | undefined {
  const segments = pathname.split('/').filter(Boolean);
  let best: { pattern: string; params: number } | undefined;
  for (const { pattern, parts } of declared) {
    const rest = '*' === parts.at(-1);
    const fixed = rest ? parts.slice(0, -1) : parts;
    if (rest ? segments.length < fixed.length : segments.length !== fixed.length) continue;
    if (!fixed.every((part, i) => part.startsWith(':') || part === segments[i])) continue;
    const params = parts.filter((part) => part.startsWith(':') || '*' === part).length;
    if (best === undefined || params < best.params) best = { pattern, params };
  }
  return best?.pattern ?? nextPattern();
}

/** Patch the History API + listen to popstate/hashchange to emit route.change. */
export function installRoute(emit: Emit): Teardown {
  const ac = new AbortController();
  // Keep the true originals for teardown identity; bound copies are used for invocation
  // (History methods throw "Illegal invocation" if called with the wrong `this`).
  const origPush = captureMethod(history, 'pushState');
  const origReplace = captureMethod(history, 'replaceState');
  const callPush = origPush.bind(history);
  const callReplace = origReplace.bind(history);

  // The `from` baseline for the NEXT popstate/hashchange. Updated in fire on every emitted change
  // — including pushState/replaceState — so a later Back nav isn't compared against a stale href
  // (which made `to === from` trip and silently drop the back navigation).
  let lastHref = location.href;

  // Guarded whole: this runs inside the app's own `history.pushState` (and inside a popstate
  // listener), so a throw anywhere in reading location or emitting would crash a router's navigate.
  const fire = (from: string, how: RouteChangeHow): void => {
    observeSafely(() => {
      const to = snapshotLocation();
      if (to.href === from) return;
      lastHref = to.href;
      // Compared raw above, sent redacted: a sign-in leaves its token in the query or fragment.
      const pattern = patternOf(to.pathname);
      emit(EventType.ROUTE_CHANGE, {
        from: redactUrl(from),
        to: redactUrl(to.href),
        pathname: to.pathname,
        ...(pattern === undefined ? {} : { pattern }),
        search: redactUrl(to.search),
        hash: redactUrl(to.hash),
        [ROUTE_CHANGE_HOW_FIELD]: how,
      });
    });
  };

  const patchedPush = (data: unknown, unused: string, url?: string | URL | null): void => {
    const from = location.href;
    callPush(data, unused, url ?? null);
    fire(from, RouteChangeHow.PUSH);
  };
  const patchedReplace = (data: unknown, unused: string, url?: string | URL | null): void => {
    const from = location.href;
    callReplace(data, unused, url ?? null);
    fire(from, RouteChangeHow.REPLACE);
  };
  history.pushState = patchedPush;
  history.replaceState = patchedReplace;

  const onNav = (): void => {
    fire(lastHref, RouteChangeHow.POP);
  };
  window.addEventListener('popstate', onNav, { signal: ac.signal });
  window.addEventListener('hashchange', onNav, { signal: ac.signal });

  return () => {
    // Restore ONLY if the slot still holds Reticle's wrapper. If a router/analytics SDK wrapped
    // history.pushState AFTER connect(), unconditionally writing origPush back would silently
    // uninstall THEIR instrumentation too — the SDK harming the app it only meant to observe.
    if (history.pushState === patchedPush) history.pushState = origPush;
    if (history.replaceState === patchedReplace) history.replaceState = origReplace;
    ac.abort();
  };
}
