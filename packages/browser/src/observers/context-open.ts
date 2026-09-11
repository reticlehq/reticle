import { EventType } from '@reticlehq/core';
import { captureMethod } from '../patching/capture-method.js';
import { observeSafely, type Emit, type Teardown } from './types.js';

/**
 * The page asked for ANOTHER browsing context — `window.open` — so the consequence of whatever was
 * just clicked may live where this document's SDK cannot follow. An OAuth sign-in is the archetype:
 * the POST succeeds, the popup carries the whole flow, and the original tab legitimately never
 * changes (#508). Without this event the contradiction layer reads that shape as response-ignored,
 * accusing the client of ignoring a response it handed to a window nobody can see.
 *
 * The wrap preserves the call exactly: same arguments, same return value, and a null/undefined
 * first argument (the "open a blank tab" form) still emits, since a blank tab can navigate anywhere.
 */
export function installContextOpen(emit: Emit): Teardown {
  const originalOpen = captureMethod(window, 'open');
  if (originalOpen === undefined) return () => {};

  const openPatch = function (
    this: Window,
    href?: string,
    target?: string,
    features?: string,
  ): Window | null {
    // The context opens FIRST and outside the guard — the app's call must succeed or fail on its own
    // terms, and `window.open` returning a handle is what the caller is written against.
    const opened = originalOpen.call(this, href, target, features);
    observeSafely(() => {
      emit(EventType.CONTEXT_OPENED, { ...(href === undefined ? {} : { href }) });
    });
    return opened;
  };

  const patchedOpen = openPatch as typeof window.open;
  window.open = patchedOpen;
  return () => {
    // Restore ONLY if the slot still holds our wrapper — the rule route.ts states: something that
    // wrapped `window.open` AFTER connect() (a popup blocker shim, an analytics SDK) keeps its
    // instrumentation instead of being silently uninstalled by ours.
    if (window.open === patchedOpen) window.open = originalOpen;
  };
}
