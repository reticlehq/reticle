import { EventType } from '@reticlehq/core';
import type { Emit, Teardown } from './types.js';
import { captureMethod } from '../patching/capture-method.js';

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

  const fire = (from: string): void => {
    const to = snapshotLocation();
    if (to.href === from) return;
    lastHref = to.href;
    emit(EventType.ROUTE_CHANGE, {
      from,
      to: to.href,
      pathname: to.pathname,
      search: to.search,
      hash: to.hash,
    });
  };

  const patchedPush = (data: unknown, unused: string, url?: string | URL | null): void => {
    const from = location.href;
    callPush(data, unused, url ?? null);
    fire(from);
  };
  const patchedReplace = (data: unknown, unused: string, url?: string | URL | null): void => {
    const from = location.href;
    callReplace(data, unused, url ?? null);
    fire(from);
  };
  history.pushState = patchedPush;
  history.replaceState = patchedReplace;

  const onNav = (): void => {
    fire(lastHref);
  };
  window.addEventListener('popstate', onNav);
  window.addEventListener('hashchange', onNav);

  return () => {
    // Restore ONLY if the slot still holds our wrapper. If a router/analytics SDK wrapped
    // history.pushState AFTER connect(), unconditionally writing origPush back would silently
    // uninstall THEIR instrumentation too — the SDK harming the app it only meant to observe.
    if (history.pushState === patchedPush) history.pushState = origPush;
    if (history.replaceState === patchedReplace) history.replaceState = origReplace;
    window.removeEventListener('popstate', onNav);
    window.removeEventListener('hashchange', onNav);
  };
}
