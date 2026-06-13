import { EventType } from '@syrin/iris-protocol';
import type { Emit, Teardown } from './types.js';

function snapshotLocation(): { pathname: string; search: string; hash: string; href: string } {
  return {
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    href: location.href,
  };
}

/** Patch the History API + listen to popstate/hashchange to emit route.change. */
export function installRoute(emit: Emit): Teardown {
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  const fire = (from: string): void => {
    const to = snapshotLocation();
    if (to.href === from) return;
    emit(EventType.ROUTE_CHANGE, {
      from,
      to: to.href,
      pathname: to.pathname,
      search: to.search,
      hash: to.hash,
    });
  };

  history.pushState = (data: unknown, unused: string, url?: string | URL | null): void => {
    const from = location.href;
    origPush(data, unused, url ?? null);
    fire(from);
  };
  history.replaceState = (data: unknown, unused: string, url?: string | URL | null): void => {
    const from = location.href;
    origReplace(data, unused, url ?? null);
    fire(from);
  };

  let lastHref = location.href;
  const onNav = (): void => {
    fire(lastHref);
    lastHref = location.href;
  };
  window.addEventListener('popstate', onNav);
  window.addEventListener('hashchange', onNav);

  return () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    window.removeEventListener('popstate', onNav);
    window.removeEventListener('hashchange', onNav);
  };
}
